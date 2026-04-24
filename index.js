const { RawSource: LegacyRawSource } = require("webpack-sources");
const evaluate = require("eval");
const path = require("path");
const cheerio = require("cheerio");
const url = require("url");

const PLUGIN_NAME = "static-site-generator-webpack-plugin";

class StaticSiteGeneratorWebpackPlugin {
  constructor(options) {
    if (typeof options !== "object") {
      options = this.legacyArgsToOptions(...arguments);
    }

    this.entry = options.entry;
    this.paths = Array.isArray(options.paths)
      ? options.paths
      : [options.paths || "/"];
    this.locals = options.locals;
    this.globals = options.globals;
    this.crawl = Boolean(options.crawl);
  }

  apply(compiler) {
    const RawSource = this.getRawSource(compiler);

    this.addThisCompilationHandler(compiler, (compilation) => {
      this.addOptimizeAssetsHandler(compiler, compilation, (_, done) => {
        try {
          const webpackStats = compilation.getStats();
          const webpackStatsJson = webpackStats.toJson();

          const asset = this.findAsset(
            this.entry,
            compilation,
            webpackStatsJson,
          );

          if (asset == null) {
            throw new Error(`Source file not found: "${this.entry}"`);
          }

          const assets = this.getAssetsFromCompilation(
            compilation,
            webpackStatsJson,
          );
          const source = this.getAssetSource(asset);

          const enhancedGlobals = {
            ...this.globals,
            // Add self reference to global scope to prevent "self is not defined" error
            self: global,
            // Also add window as an alias, common in browser code
            window: global,
          };

          let render = evaluate(
            source,
            asset.name || this.entry || "index.js",
            enhancedGlobals,
            true,
          );

          if (Object.prototype.hasOwnProperty.call(render, "default")) {
            render = render["default"];
          }

          if (typeof render !== "function") {
            throw new Error(
              `Export from "${this.entry}" must be a function that returns an HTML string. Is output.libraryTarget in the configuration set to "umd"?`,
            );
          }

          this.renderPaths(
            this.crawl,
            this.locals,
            this.paths,
            render,
            assets,
            webpackStats,
            compilation,
            RawSource,
          )
            .then(() => done())
            .catch((err) => {
              this.addCompilationError(compilation, err);
              done();
            });
        } catch (err) {
          this.addCompilationError(compilation, err);
          done();
        }
      });
    });
  }

  renderPaths(
    crawl,
    userLocals,
    paths,
    render,
    assets,
    webpackStats,
    compilation,
    RawSource,
  ) {
    userLocals = userLocals || {};

    const renderPromises = paths.map((outputPath) => {
      const locals = {
        path: outputPath,
        assets: assets,
        webpackStats: webpackStats,
      };

      for (const prop in userLocals) {
        if (Object.prototype.hasOwnProperty.call(userLocals, prop)) {
          locals[prop] = userLocals[prop];
        }
      }

      // Handle both sync and async renders
      const renderPromise =
        render.length < 2
          ? Promise.resolve(render(locals))
          : new Promise((resolve, reject) => {
              render(locals, (err, result) => {
                if (err) return reject(err);
                resolve(result);
              });
            });

      return renderPromise
        .then((output) => {
          const outputByPath =
            output != null && typeof output === "object"
              ? output
              : this.makeObject(outputPath, output);

          const assetGenerationPromises = Object.keys(outputByPath).map(
            (key) => {
              const rawSource = outputByPath[key];
              const assetName = this.pathToAssetName(key);

              if (this.getCompilationAsset(compilation, assetName)) {
                return Promise.resolve();
              }

              this.emitCompilationAsset(
                compilation,
                assetName,
                new RawSource(rawSource),
              );

              if (crawl) {
                const relativePaths = this.relativePathsFromHtml({
                  source: rawSource,
                  path: key,
                });

                return this.renderPaths(
                  crawl,
                  userLocals,
                  relativePaths,
                  render,
                  assets,
                  webpackStats,
                  compilation,
                  RawSource,
                );
              }

              return Promise.resolve();
            },
          );

          return Promise.all(assetGenerationPromises);
        })
        .catch((err) => {
          this.addCompilationError(compilation, err);
        });
    });

    return Promise.all(renderPromises);
  }

  findAsset(src, compilation, webpackStatsJson) {
    const hasExplicitSource = Boolean(src);

    if (src) {
      const asset = this.getCompilationAsset(compilation, src);

      if (asset) {
        return asset;
      }
    }

    const assetsByChunkName = this.getAssetsByChunkName(
      compilation,
      webpackStatsJson,
    );

    if (!src) {
      const chunkNames = Object.keys(assetsByChunkName);
      src = chunkNames[0] || null;
    }

    if (src == null) {
      const fallbackAssetName = this.findFirstJavaScriptAssetName(compilation);

      return fallbackAssetName
        ? this.getCompilationAsset(compilation, fallbackAssetName)
        : null;
    }

    const chunkValue = this.getJavaScriptAssetName(assetsByChunkName[src]);
    const assetName = chunkValue || src;
    const asset = this.getCompilationAsset(compilation, assetName);

    if (asset) {
      return asset;
    }

    if (hasExplicitSource) {
      return null;
    }

    const fallbackAssetName = this.findFirstJavaScriptAssetName(compilation);

    return fallbackAssetName
      ? this.getCompilationAsset(compilation, fallbackAssetName)
      : null;
  }

  getAssetsFromCompilation(compilation, webpackStatsJson) {
    const assets = {};
    const assetsByChunkName = this.getAssetsByChunkName(
      compilation,
      webpackStatsJson,
    );
    const publicPath = this.getPublicPath(compilation, webpackStatsJson);

    for (const chunk in assetsByChunkName) {
      if (!Object.prototype.hasOwnProperty.call(assetsByChunkName, chunk)) {
        continue;
      }

      const chunkValue = this.getJavaScriptAssetName(assetsByChunkName[chunk]);

      if (!chunkValue) {
        continue;
      }

      assets[chunk] = publicPath + chunkValue;
    }

    return assets;
  }

  getAssetsByChunkName(compilation, webpackStatsJson) {
    const assetsByChunkName = {};

    if (
      webpackStatsJson &&
      webpackStatsJson.assetsByChunkName &&
      typeof webpackStatsJson.assetsByChunkName === "object"
    ) {
      for (const chunkName in webpackStatsJson.assetsByChunkName) {
        if (
          !Object.prototype.hasOwnProperty.call(
            webpackStatsJson.assetsByChunkName,
            chunkName,
          )
        ) {
          continue;
        }

        this.addAssetsByChunkName(
          assetsByChunkName,
          chunkName,
          this.toArray(webpackStatsJson.assetsByChunkName[chunkName]),
        );
      }
    }

    this.addChunkGroupMapAssetsFromCompilation(
      assetsByChunkName,
      compilation && compilation.entrypoints,
    );
    this.addChunkGroupMapAssetsFromCompilation(
      assetsByChunkName,
      compilation && compilation.namedChunkGroups,
    );

    this.addChunkGroupAssets(
      assetsByChunkName,
      webpackStatsJson && webpackStatsJson.entrypoints,
    );
    this.addChunkGroupAssets(
      assetsByChunkName,
      webpackStatsJson && webpackStatsJson.namedChunkGroups,
    );
    this.addAssetsByChunkNameFromStatsAssets(
      assetsByChunkName,
      webpackStatsJson && webpackStatsJson.assets,
    );
    this.addAssetsByChunkNameFromStatsChunks(
      assetsByChunkName,
      webpackStatsJson && webpackStatsJson.chunks,
    );

    return assetsByChunkName;
  }

  addChunkGroupMapAssetsFromCompilation(assetsByChunkName, chunkGroupMap) {
    this.forEachMapEntry(chunkGroupMap, (chunkName, chunkGroup) => {
      this.addAssetsByChunkName(
        assetsByChunkName,
        chunkName,
        this.getCompilationChunkGroupFiles(chunkGroup),
      );
    });
  }

  addChunkGroupAssets(assetsByChunkName, chunkGroups) {
    if (!chunkGroups || typeof chunkGroups !== "object") {
      return;
    }

    for (const chunkName in chunkGroups) {
      if (!Object.prototype.hasOwnProperty.call(chunkGroups, chunkName)) {
        continue;
      }

      const chunkGroup = chunkGroups[chunkName];

      this.addAssetsByChunkName(
        assetsByChunkName,
        chunkName,
        this.getAssetNames(chunkGroup && chunkGroup.assets),
      );
    }
  }

  addAssetsByChunkNameFromStatsAssets(assetsByChunkName, statsAssets) {
    if (!Array.isArray(statsAssets)) {
      return;
    }

    statsAssets.forEach((asset) => {
      if (!asset || typeof asset.name !== "string") {
        return;
      }

      if (!Array.isArray(asset.chunkNames)) {
        return;
      }

      asset.chunkNames.forEach((chunkName) => {
        this.addAssetsByChunkName(assetsByChunkName, chunkName, [asset.name]);
      });
    });
  }

  addAssetsByChunkNameFromStatsChunks(assetsByChunkName, statsChunks) {
    if (!Array.isArray(statsChunks)) {
      return;
    }

    statsChunks.forEach((chunk) => {
      if (!chunk || !Array.isArray(chunk.names) || !Array.isArray(chunk.files)) {
        return;
      }

      chunk.names.forEach((chunkName) => {
        this.addAssetsByChunkName(assetsByChunkName, chunkName, chunk.files);
      });
    });
  }

  addAssetsByChunkName(assetsByChunkName, chunkName, assetNames) {
    if (!chunkName || !Array.isArray(assetNames) || assetNames.length === 0) {
      return;
    }

    if (!assetsByChunkName[chunkName]) {
      assetsByChunkName[chunkName] = [];
    }

    assetNames.forEach((assetName) => {
      if (!assetName || assetsByChunkName[chunkName].indexOf(assetName) !== -1) {
        return;
      }

      assetsByChunkName[chunkName].push(assetName);
    });
  }

  getAssetNames(assets) {
    if (!Array.isArray(assets)) {
      return [];
    }

    return assets
      .map((asset) => {
        if (typeof asset === "string") {
          return asset;
        }

        if (asset && typeof asset.name === "string") {
          return asset.name;
        }

        return null;
      })
      .filter((assetName) => assetName != null);
  }

  getCompilationChunkGroupFiles(chunkGroup) {
    if (!chunkGroup) {
      return [];
    }

    if (typeof chunkGroup.getFiles === "function") {
      return this.toArray(chunkGroup.getFiles()).filter(
        (assetName) => assetName != null,
      );
    }

    const files = [];

    this.toArray(chunkGroup.chunks).forEach((chunk) => {
      this.toArray(chunk && chunk.files).forEach((assetName) => {
        if (files.indexOf(assetName) === -1) {
          files.push(assetName);
        }
      });
    });

    return files;
  }

  forEachMapEntry(mapLike, callback) {
    if (!mapLike) {
      return;
    }

    if (typeof mapLike.forEach === "function") {
      mapLike.forEach((value, key) => {
        callback(key, value);
      });
      return;
    }

    for (const key in mapLike) {
      if (!Object.prototype.hasOwnProperty.call(mapLike, key)) {
        continue;
      }

      callback(key, mapLike[key]);
    }
  }

  toArray(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (!value || typeof value === "string") {
      return value ? [value] : [];
    }

    if (typeof value[Symbol.iterator] === "function") {
      return Array.from(value);
    }

    return [];
  }

  getJavaScriptAssetName(chunkValue) {
    if (Array.isArray(chunkValue)) {
      return chunkValue.find((filename) => this.isJavaScriptAsset(filename));
    }

    return this.isJavaScriptAsset(chunkValue) ? chunkValue : null;
  }

  isJavaScriptAsset(filename) {
    return typeof filename === "string" && /\.js(?:$|\?)/.test(filename);
  }

  findFirstJavaScriptAssetName(compilation) {
    return this.listCompilationAssetNames(compilation).find((assetName) =>
      this.isJavaScriptAsset(assetName),
    );
  }

  listCompilationAssetNames(compilation) {
    if (typeof compilation.getAssets === "function") {
      return compilation
        .getAssets()
        .map((asset) => asset.name || asset.filename)
        .filter((assetName) => assetName != null);
    }

    return Object.keys(compilation.assets || {});
  }

  getCompilationAsset(compilation, name) {
    if (!name) {
      return null;
    }

    if (typeof compilation.getAsset === "function") {
      return this.normalizeCompilationAsset(compilation.getAsset(name), name);
    }

    return this.normalizeCompilationAsset(
      compilation.assets && compilation.assets[name]
        ? { name: name, source: compilation.assets[name] }
        : null,
      name,
    );
  }

  normalizeCompilationAsset(asset, name) {
    if (!asset) {
      return null;
    }

    const source = asset.source || asset;

    if (!source || typeof source.source !== "function") {
      return null;
    }

    return {
      name: asset.name || asset.filename || name,
      source: source,
    };
  }

  getAssetSource(asset) {
    const source = asset.source.source();

    return Buffer.isBuffer(source) ? source.toString("utf8") : source;
  }

  emitCompilationAsset(compilation, assetName, source) {
    if (typeof compilation.emitAsset === "function") {
      compilation.emitAsset(assetName, source);
      return;
    }

    compilation.assets[assetName] = source;
  }

  getPublicPath(compilation, webpackStatsJson) {
    const publicPath =
      webpackStatsJson && typeof webpackStatsJson.publicPath === "string"
        ? webpackStatsJson.publicPath
        : compilation.options &&
            compilation.options.output &&
            compilation.options.output.publicPath;

    return publicPath && publicPath !== "auto" ? publicPath : "";
  }

  pathToAssetName(outputPath) {
    let outputFileName = outputPath.replace(/^(\/|\\)/, ""); // Remove leading slashes for webpack-dev-server

    if (!/\.(html?)$/i.test(outputFileName)) {
      outputFileName = path.join(outputFileName, "index.html");
    }

    return outputFileName;
  }

  makeObject(key, value) {
    const obj = {};
    obj[key] = value;
    return obj;
  }

  relativePathsFromHtml(options) {
    const html = options.source;
    const currentPath = options.path;

    const $ = cheerio.load(html);

    const linkHrefs = $("a[href]")
      .map((i, el) => $(el).attr("href"))
      .get();

    const iframeSrcs = $("iframe[src]")
      .map((i, el) => $(el).attr("src"))
      .get();

    return []
      .concat(linkHrefs)
      .concat(iframeSrcs)
      .map((href) => {
        if (href.indexOf("//") === 0) {
          return null;
        }

        const parsed = url.parse(href);

        if (parsed.protocol || typeof parsed.path !== "string") {
          return null;
        }

        return parsed.path.indexOf("/") === 0
          ? parsed.path
          : url.resolve(currentPath, parsed.path);
      })
      .filter((href) => href != null);
  }

  legacyArgsToOptions(entry, paths, locals, globals) {
    return {
      entry: entry,
      paths: paths,
      locals: locals,
      globals: globals,
    };
  }

  addThisCompilationHandler(compiler, callback) {
    if (compiler.hooks) {
      compiler.hooks.thisCompilation.tap(
        PLUGIN_NAME,
        callback,
      );
    } else {
      compiler.plugin("this-compilation", callback);
    }
  }

  addOptimizeAssetsHandler(compiler, compilation, callback) {
    if (compilation.hooks && compilation.hooks.processAssets) {
      compilation.hooks.processAssets.tapAsync(
        this.getProcessAssetsHookOptions(compiler),
        callback,
      );
    } else if (compilation.hooks && compilation.hooks.optimizeAssets) {
      compilation.hooks.optimizeAssets.tapAsync(
        PLUGIN_NAME,
        callback,
      );
    } else {
      compilation.plugin("optimize-assets", callback);
    }
  }

  getProcessAssetsHookOptions(compiler) {
    const Compilation =
      (compiler.webpack && compiler.webpack.Compilation) ||
      (compiler.rspack && compiler.rspack.Compilation);
    const hookOptions = {
      name: PLUGIN_NAME,
    };

    if (
      Compilation &&
      typeof Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL === "number"
    ) {
      hookOptions.stage = Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL;
    }

    return hookOptions;
  }

  getRawSource(compiler) {
    const sources =
      (compiler.webpack && compiler.webpack.sources) ||
      (compiler.rspack && compiler.rspack.sources);

    return (sources && sources.RawSource) || LegacyRawSource;
  }

  addCompilationError(compilation, err) {
    compilation.errors.push(err && err.stack ? err.stack : err);
  }
}

module.exports = StaticSiteGeneratorWebpackPlugin;

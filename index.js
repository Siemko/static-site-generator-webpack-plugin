const { RawSource } = require("webpack-sources");
const evaluate = require("eval");
const path = require("path");
const cheerio = require("cheerio");
const url = require("url");

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
    this.addThisCompilationHandler(compiler, (compilation) => {
      this.addOptimizeAssetsHandler(compilation, (_, done) => {
        try {
          const webpackStats = compilation.getStats();
          const webpackStatsJson = webpackStats.toJson();

          const asset = this.findAsset(this.entry, compilation, webpackStatsJson);

          if (asset == null) {
            throw new Error(`Source file not found: "${this.entry}"`);
          }

          const assets = this.getAssetsFromCompilation(compilation, webpackStatsJson);
          const source = asset.source();
          
          let render = evaluate(
            source,
            this.entry,
            this.globals,
            true
          );

          if (render.hasOwnProperty("default")) {
            render = render["default"];
          }

          if (typeof render !== "function") {
            throw new Error(
              `Export from "${this.entry}" must be a function that returns an HTML string. Is output.libraryTarget in the configuration set to "umd"?`
            );
          }

          this.renderPaths(
            this.crawl,
            this.locals,
            this.paths,
            render,
            assets,
            webpackStats,
            compilation
          ).then(() => done()).catch((err) => {
            compilation.errors.push(err.stack);
            done();
          });
        } catch (err) {
          compilation.errors.push(err.stack);
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
    compilation
  ) {
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
      const renderPromise = render.length < 2
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
            typeof output === "object" ? output : this.makeObject(outputPath, output);

          const assetGenerationPromises = Object.keys(outputByPath).map((key) => {
            const rawSource = outputByPath[key];
            const assetName = this.pathToAssetName(key);

            if (compilation.assets[assetName]) {
              return Promise.resolve();
            }

            compilation.assets[assetName] = new RawSource(rawSource);

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
                compilation
              );
            }
            
            return Promise.resolve();
          });

          return Promise.all(assetGenerationPromises);
        })
        .catch((err) => {
          compilation.errors.push(err.stack);
        });
    });

    return Promise.all(renderPromises);
  }

  findAsset(src, compilation, webpackStatsJson) {
    if (!src) {
      const chunkNames = Object.keys(webpackStatsJson.assetsByChunkName);
      src = chunkNames[0];
    }

    let asset = compilation.assets[src];

    if (asset) {
      return asset;
    }

    let chunkValue = webpackStatsJson.assetsByChunkName[src];

    if (!chunkValue) {
      return null;
    }
    
    // Webpack outputs an array for each chunk when using sourcemaps
    if (Array.isArray(chunkValue)) {
      // Find the main JS file
      chunkValue = chunkValue.find((filename) => /\.js$/.test(filename));
    }
    
    return compilation.assets[chunkValue];
  }

  getAssetsFromCompilation(compilation, webpackStatsJson) {
    const assets = {};
    
    for (const chunk in webpackStatsJson.assetsByChunkName) {
      let chunkValue = webpackStatsJson.assetsByChunkName[chunk];

      // Webpack outputs an array for each chunk when using sourcemaps
      if (Array.isArray(chunkValue)) {
        chunkValue = chunkValue.find((filename) => /\.js$/.test(filename));
      }

      if (compilation.options.output.publicPath) {
        chunkValue = compilation.options.output.publicPath + chunkValue;
      }
      
      assets[chunk] = chunkValue;
    }

    return assets;
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
        "static-site-generator-webpack-plugin",
        callback
      );
    } else {
      compiler.plugin("this-compilation", callback);
    }
  }

  addOptimizeAssetsHandler(compilation, callback) {
    if (compilation.hooks && compilation.hooks.optimizeAssets) {
      compilation.hooks.optimizeAssets.tapAsync(
        "static-site-generator-webpack-plugin",
        callback
      );
    } else if (compilation.hooks && compilation.hooks.processAssets) {
      compilation.hooks.processAssets.tapAsync(
        "static-site-generator-webpack-plugin",
        callback
      );
    } else {
      compilation.plugin("optimize-assets", callback);
    }
  }
}

module.exports = StaticSiteGeneratorWebpackPlugin;

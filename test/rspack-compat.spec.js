const StaticSiteGeneratorPlugin = require("..");

describe("Rspack compatibility", () => {
  it("supports processAssets and modern asset APIs without assetsByChunkName", (done) => {
    const plugin = new StaticSiteGeneratorPlugin({
      paths: ["/"],
    });

    const emittedAssets = {};
    let processAssetsHandler;

    const compiler = {
      rspack: {
        Compilation: {
          PROCESS_ASSETS_STAGE_ADDITIONAL: -2000,
        },
        sources: {
          RawSource: class RawSource {
            constructor(value) {
              this.value = value;
            }

            source() {
              return this.value;
            }
          },
        },
      },
      hooks: {
        thisCompilation: {
          tap(name, handler) {
            expect(name).toBe("static-site-generator-webpack-plugin");

            const compilation = {
              options: {
                output: {
                  publicPath: "/static/",
                },
              },
              errors: [],
              entrypoints: new Map([
                [
                  "main",
                  {
                    getFiles() {
                      return ["index.js", "index.css"];
                    },
                  },
                ],
              ]),
              hooks: {
                processAssets: {
                  tapAsync(options, callback) {
                    expect(options).toEqual({
                      name: "static-site-generator-webpack-plugin",
                      stage: -2000,
                    });
                    processAssetsHandler = callback;
                  },
                },
              },
              getStats() {
                return {
                  toJson() {
                    return {
                      publicPath: "/static/",
                      entrypoints: {
                        main: {
                          assets: [{ name: "index.js", size: 10 }],
                        },
                      },
                    };
                  },
                };
              },
              getAsset(name) {
                if (name === "index.js") {
                  return {
                    name,
                    source: {
                      source() {
                        return "module.exports = function render(locals) { return '<html>' + locals.assets.main + '</html>'; }";
                      },
                    },
                  };
                }

                if (emittedAssets[name]) {
                  return {
                    name,
                    source: emittedAssets[name],
                  };
                }

                return undefined;
              },
              getAssets() {
                return [
                  {
                    name: "index.js",
                    source: {
                      source() {
                        return "module.exports = function render(locals) { return '<html>' + locals.assets.main + '</html>'; }";
                      },
                    },
                  },
                ];
              },
              emitAsset(name, source) {
                emittedAssets[name] = source;
              },
            };

            handler(compilation);
          },
        },
      },
    };

    plugin.apply(compiler);

    processAssetsHandler({}, () => {
      expect(Object.keys(emittedAssets)).toEqual(["index.html"]);
      expect(emittedAssets["index.html"].source()).toBe(
        "<html>/static/index.js</html>",
      );
      done();
    });
  });
});

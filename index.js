var CachingWriter = require('broccoli-caching-writer');
var esperanto = require('esperanto');
var path = require('path');
var mkdirp = require('mkdirp');
var fs = require('fs');
var helpers = require('broccoli-kitchen-sink-helpers');
var walkSync = require('walk-sync');
var RSVP = require('rsvp');

var writeFile = RSVP.denodeify(fs.writeFile);

var formatToFunctionName = {
  amd: 'toAmd',
  cjs: 'toCjs',
  umd: 'toUmd',
  namedAmd: 'toAmd'
};

var umdMesssage = "broccoli-es6modules cannot export to unbundled UMD format. The plugin uses each file's "+
                  "filename as its module name. This strategy used with UMD will expose many properties on " +
                  "the global object, which you likely don't want. " +
                  "To use UMD, please also supply bundleOptions with a name for the bundled module.\n" +
                  "If you do want to expose this many global properties, please open an issue " +
                  "(https://github.com/ember-cli/broccoli-es6modules) "+
                  "and tells us your use case.";


module.exports = ES6Modules;
ES6Modules.prototype = Object.create(CachingWriter.prototype);
ES6Modules.prototype.constructor = ES6Modules;
function ES6Modules(inputNode, options) {
  if (!(this instanceof ES6Modules)) return new ES6Modules(inputNode, options);

  options = options || {};

  CachingWriter.call(this, [inputNode], {
    annotation: options.annotation
  });

  if (options.format != null) this.format = options.format;
  if (options.formatModuleName != null) this.formatModuleName = options.formatModuleName;
  if (options.bundleOptions != null) this.bundleOptions = options.bundleOptions;
  if (options.esperantoOptions != null) this.esperantoOptions = options.esperantoOptions;
  if (options.extensions != null) this.extensions = options.extensions;
  if (options.targetExtension != null) this.targetExtension = options.targetExtension;

  if (this.format === 'umd' && !this.bundleOptions) {
    throw new Error(umdMesssage);
  }

  // Method to delegate to esperanto for transpiling files
  this.toFormat = esperanto[formatToFunctionName[this.format]];

  // Cache that maps previously transpiled files to their resulting
  // transpiled source
  this._transpilerCache = {};
}

  /*
    The module format to transpile to.
    available types are:

      * 'cjs'
      * 'amd'
      * 'umd'
      * 'namedAmd'

    Defaults to 'namedAmd'
  */
ES6Modules.prototype.format = 'namedAmd';

  /*
    ES6Modules has two modes: 1-to-1 per-file transpilation and n-to-1 bundle
    transpilation.

    In 1-to-1 transpiling every file in a tree or
    accepting a single file that is the entry point for transpilation.

    When bundleOptions are provided, ES6Modules will start the transpilation
    process at the `entry` option and emit only a single file that contains
    the content of all the files imported, recursively, as a result of imports
    in the `entry` file.

    See http://esperantojs.org/ for a list of options you can pass for bundling.
  */
ES6Modules.prototype.bundleOptions = null;

  /*
    The options to pass to esperanto per file (in per-file mode)
    or the entire bundle (in bundling mode).

    Some defaults are provided:

    * For per-file transpilations if the format is 'namedAmd', the 'amdName' option passed to the transpiler
      for each file will be the file's relative file path, with '.js' stripped from it.
    * For per-file transpilations if `sourceMap` option is provided, the `sourceMapSource` option is passed
      to the transpiler for each file as the relative file path, with '.js' stripped from it.

    So, if you have the following tree:
    ├── inner
    │   └── first.js
    └── outer.js

    You will have the following module names passed to AMD's `define` call:
    'bundle', 'inner/first', and  'outer'.
  */
ES6Modules.prototype.esperantoOptions = null;

/*
  Main entry point. Called by CachingWriter whenever we need to rebuild.
*/
ES6Modules.prototype.build = function() {
  return this.bundleOptions ? this._updateBundle() : this._updateEachFile();
};

  /**
    A hook called if ES6Modules is being used in a n-to-1 bundle.

    Begins importing at an entry point and adds a single bundled
    module to the output tree.
  */
ES6Modules.prototype._updateBundle = function() {
    var self = this;
    var name = this.bundleOptions.name;
    var opts = this._generateEsperantoOptions(name);
    var transpilerName = formatToFunctionName[this.format];
    var targetExtension = this.targetExtension;

    return esperanto.bundle({
      base: this.inputPaths[0],
      entry: this.bundleOptions.entry
    }).then(function(bundle) {
      var compiledModule = bundle[transpilerName](opts);
      var fullOutputPath = path.join(self.outputPath, name + '.' + targetExtension);

      return writeFile(fullOutputPath, compiledModule.code);
    });
};

  /**
    A hook called if ES6Modules is being used in a 1-to-1 per-per file mode
    (the default).

    Creates a new cache then delegates to `handleFile` for every file, which
    checks the old cache for presence of transpiled code and inserts the cached
    code (or a newly transpiled code) into the new cache.

    Finally, the old cache is overwritten by the new cache.
  */
ES6Modules.prototype._updateEachFile = function() {
    // this object is passed through the caching process
    // and populated with newly generated or previously cached
    // values. It becomes the new cache;
    var _newTranspilerCache = {};

    walkSync(this.inputPaths[0])
      .forEach(function(relativePath) {
        if (this._shouldProcessFile(relativePath)) {
          this._handleFile(relativePath, _newTranspilerCache);
        }
      }, this);

    this._transpilerCache = _newTranspilerCache;
};

  /**
    Normalizes module name, input path, and output path
    then calls transpileThroughCache to get a transpiled
    version of the ES6 source.
  */
ES6Modules.prototype._handleFile = function(relativePath, newCache) {
    var ext = this._matchingFileExtension(relativePath);
    var moduleName = relativePath.slice(0, relativePath.length - (ext.length + 1));
    var fullInputPath = path.join(this.inputPaths[0], relativePath);
    var fullOutputPath = path.join(this.outputPath, moduleName + '.' + this.targetExtension);

    var entry = this._transpileThroughCache(
      moduleName,
      fs.readFileSync(fullInputPath, 'utf-8'),
      newCache
    );

    mkdirp.sync(path.dirname(fullOutputPath));
    fs.writeFileSync(fullOutputPath, entry.output);
};

  /**
    Called on every file in a tree when used in per-file mode.

    First this checks whether the file contents have been previously
    transpiled by checking the previous cache. If the file has been transpiled,
    adds the previous transpiled code into the new cache. If it has not been transpiled
    it adds passed the source code along to a transpiler and adds the resulting value
    to the new cache.
  */
ES6Modules.prototype._transpileThroughCache = function(moduleName, source, newCache) {
    var key = helpers.hashStrings([moduleName, source]);
    var entry = this._transpilerCache[key];

    if (entry) {
      return newCache[key] = entry;
    }
    try {
      return newCache[key] = {
        output: this.toFormat(
          source,
          this._generateEsperantoOptions(moduleName)
        ).code
      };
    } catch(err) {
      err.file = moduleName;
      throw err;
    }
};

ES6Modules.prototype._generateEsperantoOptions = function(moduleName) {
    var providedOptions = this.esperantoOptions || {};
    var options = {};

    if (this.format === 'namedAmd') {
      if (typeof this.formatModuleName === 'function') {
          moduleName = this.formatModuleName(moduleName);
      }
      options.amdName = moduleName;
    }

    if (this.format === 'umd') {
      options.name = moduleName;
    }

    if (providedOptions.sourceMap) {
      options.sourceMapSource = moduleName;
    }

    for (var keyName in providedOptions) {
      options[keyName] = providedOptions[keyName];
    }


    return options;
};

ES6Modules.prototype.extensions = ['js'];
ES6Modules.prototype.targetExtension = 'js';
ES6Modules.prototype._matchingFileExtension = function(relativePath) {
    for (var i = 0; i < this.extensions.length; i++) {
      var ext = this.extensions[i];
      if (relativePath.slice(-ext.length - 1) === '.' + ext) {
        return ext;
      }
    }
    return null;
};

ES6Modules.prototype._shouldProcessFile = function(relativePath) {
    return !!this._matchingFileExtension(relativePath);
};

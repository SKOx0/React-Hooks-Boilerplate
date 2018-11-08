#!/usr/bin/env node

/* eslint-disable max-len, flowtype/require-valid-file-annotation, flowtype/require-return-type */
/* global packageInformationStores, null, $$SETUP_STATIC_TABLES */

// Used for the resolveUnqualified part of the resolution (ie resolving folder/index.js & file extensions)
// Deconstructed so that they aren't affected by any fs monkeypatching occuring later during the execution
const {statSync, lstatSync, readlinkSync, readFileSync, existsSync, realpathSync} = require('fs');

const Module = require('module');
const path = require('path');
const StringDecoder = require('string_decoder');

const ignorePattern = null ? new RegExp(null) : null;

const builtinModules = new Set(Module.builtinModules || Object.keys(process.binding('natives')));

const topLevelLocator = {name: null, reference: null};
const blacklistedLocator = {name: NaN, reference: NaN};

// Used for compatibility purposes - cf setupCompatibilityLayer
const patchedModules = new Map();
const fallbackLocators = [topLevelLocator];

// Matches backslashes of Windows paths
const backwardSlashRegExp = /\\/g;

// Matches if the path must point to a directory (ie ends with /)
const isDirRegExp = /\/$/;

// Matches if the path starts with a valid path qualifier (./, ../, /)
// eslint-disable-next-line no-unused-vars
const isStrictRegExp = /^\.{0,2}\//;

// Splits a require request into its components, or return null if the request is a file path
const pathRegExp = /^(?!\.{0,2}(?:\/|$))((?:@[^\/]+\/)?[^\/]+)\/?(.*|)$/;

// Keep a reference around ("module" is a common name in this context, so better rename it to something more significant)
const pnpModule = module;

/**
 * Used to disable the resolution hooks (for when we want to fallback to the previous resolution - we then need
 * a way to "reset" the environment temporarily)
 */

let enableNativeHooks = true;

/**
 * Simple helper function that assign an error code to an error, so that it can more easily be caught and used
 * by third-parties.
 */

function makeError(code, message, data = {}) {
  const error = new Error(message);
  return Object.assign(error, {code, data});
}

/**
 * Ensures that the returned locator isn't a blacklisted one.
 *
 * Blacklisted packages are packages that cannot be used because their dependencies cannot be deduced. This only
 * happens with peer dependencies, which effectively have different sets of dependencies depending on their parents.
 *
 * In order to deambiguate those different sets of dependencies, the Yarn implementation of PnP will generate a
 * symlink for each combination of <package name>/<package version>/<dependent package> it will find, and will
 * blacklist the target of those symlinks. By doing this, we ensure that files loaded through a specific path
 * will always have the same set of dependencies, provided the symlinks are correctly preserved.
 *
 * Unfortunately, some tools do not preserve them, and when it happens PnP isn't able anymore to deduce the set of
 * dependencies based on the path of the file that makes the require calls. But since we've blacklisted those paths,
 * we're able to print a more helpful error message that points out that a third-party package is doing something
 * incompatible!
 */

// eslint-disable-next-line no-unused-vars
function blacklistCheck(locator) {
  if (locator === blacklistedLocator) {
    throw makeError(
      `BLACKLISTED`,
      [
        `A package has been resolved through a blacklisted path - this is usually caused by one of your tools calling`,
        `"realpath" on the return value of "require.resolve". Since the returned values use symlinks to disambiguate`,
        `peer dependencies, they must be passed untransformed to "require".`,
      ].join(` `),
    );
  }

  return locator;
}

let packageInformationStores = new Map([
  ["react", new Map([
    ["16.7.0-alpha.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-react-16.7.0-alpha.0-e2ed4abe6f268c9b092a1d1e572953684d1783a9/node_modules/react/"),
      packageDependencies: new Map([
        ["loose-envify", "1.4.0"],
        ["object-assign", "4.1.1"],
        ["prop-types", "15.6.2"],
        ["scheduler", "0.11.0"],
        ["react", "16.7.0-alpha.0"],
      ]),
    }],
  ])],
  ["loose-envify", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-loose-envify-1.4.0-71ee51fa7be4caec1a63839f7e682d8132d30caf/node_modules/loose-envify/"),
      packageDependencies: new Map([
        ["js-tokens", "4.0.0"],
        ["loose-envify", "1.4.0"],
      ]),
    }],
  ])],
  ["js-tokens", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-js-tokens-4.0.0-19203fb59991df98e3a287050d4647cdeaf32499/node_modules/js-tokens/"),
      packageDependencies: new Map([
        ["js-tokens", "4.0.0"],
      ]),
    }],
  ])],
  ["object-assign", new Map([
    ["4.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-assign-4.1.1-2109adc7965887cfc05cbbd442cac8bfbb360863/node_modules/object-assign/"),
      packageDependencies: new Map([
        ["object-assign", "4.1.1"],
      ]),
    }],
  ])],
  ["prop-types", new Map([
    ["15.6.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-prop-types-15.6.2-05d5ca77b4453e985d60fc7ff8c859094a497102/node_modules/prop-types/"),
      packageDependencies: new Map([
        ["loose-envify", "1.4.0"],
        ["object-assign", "4.1.1"],
        ["prop-types", "15.6.2"],
      ]),
    }],
  ])],
  ["scheduler", new Map([
    ["0.11.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-scheduler-0.11.0-def1f1bfa6550cc57981a87106e65e8aea41a6b5/node_modules/scheduler/"),
      packageDependencies: new Map([
        ["loose-envify", "1.4.0"],
        ["object-assign", "4.1.1"],
        ["scheduler", "0.11.0"],
      ]),
    }],
  ])],
  ["webpack", new Map([
    ["4.25.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-webpack-4.25.1-4f459fbaea0f93440dc86c89f771bb3a837cfb6d/node_modules/webpack/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/helper-module-context", "1.7.11"],
        ["@webassemblyjs/wasm-edit", "1.7.11"],
        ["@webassemblyjs/wasm-parser", "1.7.11"],
        ["acorn", "5.7.3"],
        ["acorn-dynamic-import", "3.0.0"],
        ["ajv", "6.5.5"],
        ["ajv-keywords", "pnp:d710ebf99eab5562e4c283c79cc171136f17afad"],
        ["chrome-trace-event", "1.0.0"],
        ["enhanced-resolve", "4.1.0"],
        ["eslint-scope", "4.0.0"],
        ["json-parse-better-errors", "1.0.2"],
        ["loader-runner", "2.3.1"],
        ["loader-utils", "1.1.0"],
        ["memory-fs", "0.4.1"],
        ["micromatch", "3.1.10"],
        ["mkdirp", "0.5.1"],
        ["neo-async", "2.6.0"],
        ["node-libs-browser", "2.1.0"],
        ["schema-utils", "0.4.7"],
        ["tapable", "1.1.0"],
        ["uglifyjs-webpack-plugin", "1.3.0"],
        ["watchpack", "1.6.0"],
        ["webpack-sources", "1.3.0"],
        ["webpack", "4.25.1"],
      ]),
    }],
  ])],
  ["@webassemblyjs/ast", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-ast-1.7.11-b988582cafbb2b095e8b556526f30c90d057cace/node_modules/@webassemblyjs/ast/"),
      packageDependencies: new Map([
        ["@webassemblyjs/helper-module-context", "1.7.11"],
        ["@webassemblyjs/helper-wasm-bytecode", "1.7.11"],
        ["@webassemblyjs/wast-parser", "1.7.11"],
        ["@webassemblyjs/ast", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-module-context", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-module-context-1.7.11-d874d722e51e62ac202476935d649c802fa0e209/node_modules/@webassemblyjs/helper-module-context/"),
      packageDependencies: new Map([
        ["@webassemblyjs/helper-module-context", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-wasm-bytecode", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-wasm-bytecode-1.7.11-dd9a1e817f1c2eb105b4cf1013093cb9f3c9cb06/node_modules/@webassemblyjs/helper-wasm-bytecode/"),
      packageDependencies: new Map([
        ["@webassemblyjs/helper-wasm-bytecode", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/wast-parser", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wast-parser-1.7.11-25bd117562ca8c002720ff8116ef9072d9ca869c/node_modules/@webassemblyjs/wast-parser/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/floating-point-hex-parser", "1.7.11"],
        ["@webassemblyjs/helper-api-error", "1.7.11"],
        ["@webassemblyjs/helper-code-frame", "1.7.11"],
        ["@webassemblyjs/helper-fsm", "1.7.11"],
        ["@xtuc/long", "4.2.1"],
        ["@webassemblyjs/wast-parser", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/floating-point-hex-parser", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-floating-point-hex-parser-1.7.11-a69f0af6502eb9a3c045555b1a6129d3d3f2e313/node_modules/@webassemblyjs/floating-point-hex-parser/"),
      packageDependencies: new Map([
        ["@webassemblyjs/floating-point-hex-parser", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-api-error", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-api-error-1.7.11-c7b6bb8105f84039511a2b39ce494f193818a32a/node_modules/@webassemblyjs/helper-api-error/"),
      packageDependencies: new Map([
        ["@webassemblyjs/helper-api-error", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-code-frame", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-code-frame-1.7.11-cf8f106e746662a0da29bdef635fcd3d1248364b/node_modules/@webassemblyjs/helper-code-frame/"),
      packageDependencies: new Map([
        ["@webassemblyjs/wast-printer", "1.7.11"],
        ["@webassemblyjs/helper-code-frame", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/wast-printer", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wast-printer-1.7.11-c4245b6de242cb50a2cc950174fdbf65c78d7813/node_modules/@webassemblyjs/wast-printer/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/wast-parser", "1.7.11"],
        ["@xtuc/long", "4.2.1"],
        ["@webassemblyjs/wast-printer", "1.7.11"],
      ]),
    }],
  ])],
  ["@xtuc/long", new Map([
    ["4.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@xtuc-long-4.2.1-5c85d662f76fa1d34575766c5dcd6615abcd30d8/node_modules/@xtuc/long/"),
      packageDependencies: new Map([
        ["@xtuc/long", "4.2.1"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-fsm", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-fsm-1.7.11-df38882a624080d03f7503f93e3f17ac5ac01181/node_modules/@webassemblyjs/helper-fsm/"),
      packageDependencies: new Map([
        ["@webassemblyjs/helper-fsm", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/wasm-edit", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-edit-1.7.11-8c74ca474d4f951d01dbae9bd70814ee22a82005/node_modules/@webassemblyjs/wasm-edit/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/helper-buffer", "1.7.11"],
        ["@webassemblyjs/helper-wasm-bytecode", "1.7.11"],
        ["@webassemblyjs/helper-wasm-section", "1.7.11"],
        ["@webassemblyjs/wasm-gen", "1.7.11"],
        ["@webassemblyjs/wasm-opt", "1.7.11"],
        ["@webassemblyjs/wasm-parser", "1.7.11"],
        ["@webassemblyjs/wast-printer", "1.7.11"],
        ["@webassemblyjs/wasm-edit", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-buffer", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-buffer-1.7.11-3122d48dcc6c9456ed982debe16c8f37101df39b/node_modules/@webassemblyjs/helper-buffer/"),
      packageDependencies: new Map([
        ["@webassemblyjs/helper-buffer", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/helper-wasm-section", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-wasm-section-1.7.11-9c9ac41ecf9fbcfffc96f6d2675e2de33811e68a/node_modules/@webassemblyjs/helper-wasm-section/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/helper-buffer", "1.7.11"],
        ["@webassemblyjs/helper-wasm-bytecode", "1.7.11"],
        ["@webassemblyjs/wasm-gen", "1.7.11"],
        ["@webassemblyjs/helper-wasm-section", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/wasm-gen", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-gen-1.7.11-9bbba942f22375686a6fb759afcd7ac9c45da1a8/node_modules/@webassemblyjs/wasm-gen/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/helper-wasm-bytecode", "1.7.11"],
        ["@webassemblyjs/ieee754", "1.7.11"],
        ["@webassemblyjs/leb128", "1.7.11"],
        ["@webassemblyjs/utf8", "1.7.11"],
        ["@webassemblyjs/wasm-gen", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/ieee754", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-ieee754-1.7.11-c95839eb63757a31880aaec7b6512d4191ac640b/node_modules/@webassemblyjs/ieee754/"),
      packageDependencies: new Map([
        ["@xtuc/ieee754", "1.2.0"],
        ["@webassemblyjs/ieee754", "1.7.11"],
      ]),
    }],
  ])],
  ["@xtuc/ieee754", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@xtuc-ieee754-1.2.0-eef014a3145ae477a1cbc00cd1e552336dceb790/node_modules/@xtuc/ieee754/"),
      packageDependencies: new Map([
        ["@xtuc/ieee754", "1.2.0"],
      ]),
    }],
  ])],
  ["@webassemblyjs/leb128", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-leb128-1.7.11-d7267a1ee9c4594fd3f7e37298818ec65687db63/node_modules/@webassemblyjs/leb128/"),
      packageDependencies: new Map([
        ["@xtuc/long", "4.2.1"],
        ["@webassemblyjs/leb128", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/utf8", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-utf8-1.7.11-06d7218ea9fdc94a6793aa92208160db3d26ee82/node_modules/@webassemblyjs/utf8/"),
      packageDependencies: new Map([
        ["@webassemblyjs/utf8", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/wasm-opt", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-opt-1.7.11-b331e8e7cef8f8e2f007d42c3a36a0580a7d6ca7/node_modules/@webassemblyjs/wasm-opt/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/helper-buffer", "1.7.11"],
        ["@webassemblyjs/wasm-gen", "1.7.11"],
        ["@webassemblyjs/wasm-parser", "1.7.11"],
        ["@webassemblyjs/wasm-opt", "1.7.11"],
      ]),
    }],
  ])],
  ["@webassemblyjs/wasm-parser", new Map([
    ["1.7.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-parser-1.7.11-6e3d20fa6a3519f6b084ef9391ad58211efb0a1a/node_modules/@webassemblyjs/wasm-parser/"),
      packageDependencies: new Map([
        ["@webassemblyjs/ast", "1.7.11"],
        ["@webassemblyjs/helper-api-error", "1.7.11"],
        ["@webassemblyjs/helper-wasm-bytecode", "1.7.11"],
        ["@webassemblyjs/ieee754", "1.7.11"],
        ["@webassemblyjs/leb128", "1.7.11"],
        ["@webassemblyjs/utf8", "1.7.11"],
        ["@webassemblyjs/wasm-parser", "1.7.11"],
      ]),
    }],
  ])],
  ["acorn", new Map([
    ["5.7.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-acorn-5.7.3-67aa231bf8812974b85235a96771eb6bd07ea279/node_modules/acorn/"),
      packageDependencies: new Map([
        ["acorn", "5.7.3"],
      ]),
    }],
  ])],
  ["acorn-dynamic-import", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-acorn-dynamic-import-3.0.0-901ceee4c7faaef7e07ad2a47e890675da50a278/node_modules/acorn-dynamic-import/"),
      packageDependencies: new Map([
        ["acorn", "5.7.3"],
        ["acorn-dynamic-import", "3.0.0"],
      ]),
    }],
  ])],
  ["ajv", new Map([
    ["6.5.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ajv-6.5.5-cf97cdade71c6399a92c6d6c4177381291b781a1/node_modules/ajv/"),
      packageDependencies: new Map([
        ["fast-deep-equal", "2.0.1"],
        ["fast-json-stable-stringify", "2.0.0"],
        ["json-schema-traverse", "0.4.1"],
        ["uri-js", "4.2.2"],
        ["ajv", "6.5.5"],
      ]),
    }],
  ])],
  ["fast-deep-equal", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fast-deep-equal-2.0.1-7b05218ddf9667bf7f370bf7fdb2cb15fdd0aa49/node_modules/fast-deep-equal/"),
      packageDependencies: new Map([
        ["fast-deep-equal", "2.0.1"],
      ]),
    }],
  ])],
  ["fast-json-stable-stringify", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fast-json-stable-stringify-2.0.0-d5142c0caee6b1189f87d3a76111064f86c8bbf2/node_modules/fast-json-stable-stringify/"),
      packageDependencies: new Map([
        ["fast-json-stable-stringify", "2.0.0"],
      ]),
    }],
  ])],
  ["json-schema-traverse", new Map([
    ["0.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-json-schema-traverse-0.4.1-69f6a87d9513ab8bb8fe63bdb0979c448e684660/node_modules/json-schema-traverse/"),
      packageDependencies: new Map([
        ["json-schema-traverse", "0.4.1"],
      ]),
    }],
  ])],
  ["uri-js", new Map([
    ["4.2.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-uri-js-4.2.2-94c540e1ff772956e2299507c010aea6c8838eb0/node_modules/uri-js/"),
      packageDependencies: new Map([
        ["punycode", "2.1.1"],
        ["uri-js", "4.2.2"],
      ]),
    }],
  ])],
  ["punycode", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-punycode-2.1.1-b58b010ac40c22c5657616c8d2c2c02c7bf479ec/node_modules/punycode/"),
      packageDependencies: new Map([
        ["punycode", "2.1.1"],
      ]),
    }],
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-punycode-1.4.1-c0d5a63b2718800ad8e1eb0fa5269c84dd41845e/node_modules/punycode/"),
      packageDependencies: new Map([
        ["punycode", "1.4.1"],
      ]),
    }],
    ["1.3.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-punycode-1.3.2-9653a036fb7c1ee42342f2325cceefea3926c48d/node_modules/punycode/"),
      packageDependencies: new Map([
        ["punycode", "1.3.2"],
      ]),
    }],
  ])],
  ["ajv-keywords", new Map([
    ["pnp:d710ebf99eab5562e4c283c79cc171136f17afad", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-d710ebf99eab5562e4c283c79cc171136f17afad/node_modules/ajv-keywords/"),
      packageDependencies: new Map([
        ["ajv", "6.5.5"],
        ["ajv-keywords", "pnp:d710ebf99eab5562e4c283c79cc171136f17afad"],
      ]),
    }],
    ["pnp:66d890350fb9581c203378c25d039e96f4f2feb9", {
      packageLocation: path.resolve(__dirname, "./.pnp/externals/pnp-66d890350fb9581c203378c25d039e96f4f2feb9/node_modules/ajv-keywords/"),
      packageDependencies: new Map([
        ["ajv", "6.5.5"],
        ["ajv-keywords", "pnp:66d890350fb9581c203378c25d039e96f4f2feb9"],
      ]),
    }],
  ])],
  ["chrome-trace-event", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chrome-trace-event-1.0.0-45a91bd2c20c9411f0963b5aaeb9a1b95e09cc48/node_modules/chrome-trace-event/"),
      packageDependencies: new Map([
        ["tslib", "1.9.3"],
        ["chrome-trace-event", "1.0.0"],
      ]),
    }],
  ])],
  ["tslib", new Map([
    ["1.9.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tslib-1.9.3-d7e4dd79245d85428c4d7e4822a79917954ca286/node_modules/tslib/"),
      packageDependencies: new Map([
        ["tslib", "1.9.3"],
      ]),
    }],
  ])],
  ["enhanced-resolve", new Map([
    ["4.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-enhanced-resolve-4.1.0-41c7e0bfdfe74ac1ffe1e57ad6a5c6c9f3742a7f/node_modules/enhanced-resolve/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["memory-fs", "0.4.1"],
        ["tapable", "1.1.0"],
        ["enhanced-resolve", "4.1.0"],
      ]),
    }],
  ])],
  ["graceful-fs", new Map([
    ["4.1.15", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-graceful-fs-4.1.15-ffb703e1066e8a0eeaa4c8b80ba9253eeefbfb00/node_modules/graceful-fs/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
      ]),
    }],
  ])],
  ["memory-fs", new Map([
    ["0.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-memory-fs-0.4.1-3a9a20b8462523e447cfbc7e8bb80ed667bfc552/node_modules/memory-fs/"),
      packageDependencies: new Map([
        ["errno", "0.1.7"],
        ["readable-stream", "2.3.6"],
        ["memory-fs", "0.4.1"],
      ]),
    }],
  ])],
  ["errno", new Map([
    ["0.1.7", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-errno-0.1.7-4684d71779ad39af177e3f007996f7c67c852618/node_modules/errno/"),
      packageDependencies: new Map([
        ["prr", "1.0.1"],
        ["errno", "0.1.7"],
      ]),
    }],
  ])],
  ["prr", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-prr-1.0.1-d3fc114ba06995a45ec6893f484ceb1d78f5f476/node_modules/prr/"),
      packageDependencies: new Map([
        ["prr", "1.0.1"],
      ]),
    }],
  ])],
  ["readable-stream", new Map([
    ["2.3.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-readable-stream-2.3.6-b11c27d88b8ff1fbe070643cf94b0c79ae1b0aaf/node_modules/readable-stream/"),
      packageDependencies: new Map([
        ["core-util-is", "1.0.2"],
        ["inherits", "2.0.3"],
        ["isarray", "1.0.0"],
        ["process-nextick-args", "2.0.0"],
        ["safe-buffer", "5.1.2"],
        ["string_decoder", "1.1.1"],
        ["util-deprecate", "1.0.2"],
        ["readable-stream", "2.3.6"],
      ]),
    }],
  ])],
  ["core-util-is", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-core-util-is-1.0.2-b5fd54220aa2bc5ab57aab7140c940754503c1a7/node_modules/core-util-is/"),
      packageDependencies: new Map([
        ["core-util-is", "1.0.2"],
      ]),
    }],
  ])],
  ["inherits", new Map([
    ["2.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inherits-2.0.3-633c2c83e3da42a502f52466022480f4208261de/node_modules/inherits/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
      ]),
    }],
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inherits-2.0.1-b17d08d326b4423e568eff719f91b0b1cbdf69f1/node_modules/inherits/"),
      packageDependencies: new Map([
        ["inherits", "2.0.1"],
      ]),
    }],
  ])],
  ["isarray", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isarray-1.0.0-bb935d48582cba168c06834957a54a3e07124f11/node_modules/isarray/"),
      packageDependencies: new Map([
        ["isarray", "1.0.0"],
      ]),
    }],
  ])],
  ["process-nextick-args", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-process-nextick-args-2.0.0-a37d732f4271b4ab1ad070d35508e8290788ffaa/node_modules/process-nextick-args/"),
      packageDependencies: new Map([
        ["process-nextick-args", "2.0.0"],
      ]),
    }],
  ])],
  ["safe-buffer", new Map([
    ["5.1.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-safe-buffer-5.1.2-991ec69d296e0313747d59bdfd2b745c35f8828d/node_modules/safe-buffer/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
      ]),
    }],
  ])],
  ["string_decoder", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-string-decoder-1.1.1-9cf1611ba62685d7030ae9e4ba34149c3af03fc8/node_modules/string_decoder/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["string_decoder", "1.1.1"],
      ]),
    }],
  ])],
  ["util-deprecate", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-util-deprecate-1.0.2-450d4dc9fa70de732762fbd2d4a28981419a0ccf/node_modules/util-deprecate/"),
      packageDependencies: new Map([
        ["util-deprecate", "1.0.2"],
      ]),
    }],
  ])],
  ["tapable", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tapable-1.1.0-0d076a172e3d9ba088fd2272b2668fb8d194b78c/node_modules/tapable/"),
      packageDependencies: new Map([
        ["tapable", "1.1.0"],
      ]),
    }],
  ])],
  ["eslint-scope", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-eslint-scope-4.0.0-50bf3071e9338bcdc43331794a0cb533f0136172/node_modules/eslint-scope/"),
      packageDependencies: new Map([
        ["esrecurse", "4.2.1"],
        ["estraverse", "4.2.0"],
        ["eslint-scope", "4.0.0"],
      ]),
    }],
  ])],
  ["esrecurse", new Map([
    ["4.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-esrecurse-4.2.1-007a3b9fdbc2b3bb87e4879ea19c92fdbd3942cf/node_modules/esrecurse/"),
      packageDependencies: new Map([
        ["estraverse", "4.2.0"],
        ["esrecurse", "4.2.1"],
      ]),
    }],
  ])],
  ["estraverse", new Map([
    ["4.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-estraverse-4.2.0-0dee3fed31fcd469618ce7342099fc1afa0bdb13/node_modules/estraverse/"),
      packageDependencies: new Map([
        ["estraverse", "4.2.0"],
      ]),
    }],
  ])],
  ["json-parse-better-errors", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-json-parse-better-errors-1.0.2-bb867cfb3450e69107c131d1c514bab3dc8bcaa9/node_modules/json-parse-better-errors/"),
      packageDependencies: new Map([
        ["json-parse-better-errors", "1.0.2"],
      ]),
    }],
  ])],
  ["loader-runner", new Map([
    ["2.3.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-loader-runner-2.3.1-026f12fe7c3115992896ac02ba022ba92971b979/node_modules/loader-runner/"),
      packageDependencies: new Map([
        ["loader-runner", "2.3.1"],
      ]),
    }],
  ])],
  ["loader-utils", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-loader-utils-1.1.0-c98aef488bcceda2ffb5e2de646d6a754429f5cd/node_modules/loader-utils/"),
      packageDependencies: new Map([
        ["big.js", "3.2.0"],
        ["emojis-list", "2.1.0"],
        ["json5", "0.5.1"],
        ["loader-utils", "1.1.0"],
      ]),
    }],
  ])],
  ["big.js", new Map([
    ["3.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-big-js-3.2.0-a5fc298b81b9e0dca2e458824784b65c52ba588e/node_modules/big.js/"),
      packageDependencies: new Map([
        ["big.js", "3.2.0"],
      ]),
    }],
  ])],
  ["emojis-list", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-emojis-list-2.1.0-4daa4d9db00f9819880c79fa457ae5b09a1fd389/node_modules/emojis-list/"),
      packageDependencies: new Map([
        ["emojis-list", "2.1.0"],
      ]),
    }],
  ])],
  ["json5", new Map([
    ["0.5.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-json5-0.5.1-1eade7acc012034ad84e2396767ead9fa5495821/node_modules/json5/"),
      packageDependencies: new Map([
        ["json5", "0.5.1"],
      ]),
    }],
  ])],
  ["micromatch", new Map([
    ["3.1.10", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-micromatch-3.1.10-70859bc95c9840952f359a068a3fc49f9ecfac23/node_modules/micromatch/"),
      packageDependencies: new Map([
        ["arr-diff", "4.0.0"],
        ["array-unique", "0.3.2"],
        ["braces", "2.3.2"],
        ["define-property", "2.0.2"],
        ["extend-shallow", "3.0.2"],
        ["extglob", "2.0.4"],
        ["fragment-cache", "0.2.1"],
        ["kind-of", "6.0.2"],
        ["nanomatch", "1.2.13"],
        ["object.pick", "1.3.0"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["micromatch", "3.1.10"],
      ]),
    }],
  ])],
  ["arr-diff", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-arr-diff-4.0.0-d6461074febfec71e7e15235761a329a5dc7c520/node_modules/arr-diff/"),
      packageDependencies: new Map([
        ["arr-diff", "4.0.0"],
      ]),
    }],
  ])],
  ["array-unique", new Map([
    ["0.3.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-array-unique-0.3.2-a894b75d4bc4f6cd679ef3244a9fd8f46ae2d428/node_modules/array-unique/"),
      packageDependencies: new Map([
        ["array-unique", "0.3.2"],
      ]),
    }],
  ])],
  ["braces", new Map([
    ["2.3.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-braces-2.3.2-5979fd3f14cd531565e5fa2df1abfff1dfaee729/node_modules/braces/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
        ["array-unique", "0.3.2"],
        ["extend-shallow", "2.0.1"],
        ["fill-range", "4.0.0"],
        ["isobject", "3.0.1"],
        ["repeat-element", "1.1.3"],
        ["snapdragon", "0.8.2"],
        ["snapdragon-node", "2.1.1"],
        ["split-string", "3.1.0"],
        ["to-regex", "3.0.2"],
        ["braces", "2.3.2"],
      ]),
    }],
  ])],
  ["arr-flatten", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-arr-flatten-1.1.0-36048bbff4e7b47e136644316c99669ea5ae91f1/node_modules/arr-flatten/"),
      packageDependencies: new Map([
        ["arr-flatten", "1.1.0"],
      ]),
    }],
  ])],
  ["extend-shallow", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-extend-shallow-2.0.1-51af7d614ad9a9f610ea1bafbb989d6b1c56890f/node_modules/extend-shallow/"),
      packageDependencies: new Map([
        ["is-extendable", "0.1.1"],
        ["extend-shallow", "2.0.1"],
      ]),
    }],
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-extend-shallow-3.0.2-26a71aaf073b39fb2127172746131c2704028db8/node_modules/extend-shallow/"),
      packageDependencies: new Map([
        ["assign-symbols", "1.0.0"],
        ["is-extendable", "1.0.1"],
        ["extend-shallow", "3.0.2"],
      ]),
    }],
  ])],
  ["is-extendable", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-extendable-0.1.1-62b110e289a471418e3ec36a617d472e301dfc89/node_modules/is-extendable/"),
      packageDependencies: new Map([
        ["is-extendable", "0.1.1"],
      ]),
    }],
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-extendable-1.0.1-a7470f9e426733d81bd81e1155264e3a3507cab4/node_modules/is-extendable/"),
      packageDependencies: new Map([
        ["is-plain-object", "2.0.4"],
        ["is-extendable", "1.0.1"],
      ]),
    }],
  ])],
  ["fill-range", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fill-range-4.0.0-d544811d428f98eb06a63dc402d2403c328c38f7/node_modules/fill-range/"),
      packageDependencies: new Map([
        ["extend-shallow", "2.0.1"],
        ["is-number", "3.0.0"],
        ["repeat-string", "1.6.1"],
        ["to-regex-range", "2.1.1"],
        ["fill-range", "4.0.0"],
      ]),
    }],
  ])],
  ["is-number", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-number-3.0.0-24fd6201a4782cf50561c810276afc7d12d71195/node_modules/is-number/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-number", "3.0.0"],
      ]),
    }],
  ])],
  ["kind-of", new Map([
    ["3.2.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-3.2.2-31ea21a734bab9bbb0f32466d893aea51e4a3c64/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
        ["kind-of", "3.2.2"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-4.0.0-20813df3d712928b207378691a45066fae72dd57/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
        ["kind-of", "4.0.0"],
      ]),
    }],
    ["5.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-5.1.0-729c91e2d857b7a419a1f9aa65685c4c33f5845d/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["kind-of", "5.1.0"],
      ]),
    }],
    ["6.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-6.0.2-01146b36a6218e64e58f3a8d66de5d7fc6f6d051/node_modules/kind-of/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
      ]),
    }],
  ])],
  ["is-buffer", new Map([
    ["1.1.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-buffer-1.1.6-efaa2ea9daa0d7ab2ea13a97b2b8ad51fefbe8be/node_modules/is-buffer/"),
      packageDependencies: new Map([
        ["is-buffer", "1.1.6"],
      ]),
    }],
  ])],
  ["repeat-string", new Map([
    ["1.6.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-repeat-string-1.6.1-8dcae470e1c88abc2d600fff4a776286da75e637/node_modules/repeat-string/"),
      packageDependencies: new Map([
        ["repeat-string", "1.6.1"],
      ]),
    }],
  ])],
  ["to-regex-range", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-regex-range-2.1.1-7c80c17b9dfebe599e27367e0d4dd5590141db38/node_modules/to-regex-range/"),
      packageDependencies: new Map([
        ["is-number", "3.0.0"],
        ["repeat-string", "1.6.1"],
        ["to-regex-range", "2.1.1"],
      ]),
    }],
  ])],
  ["isobject", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isobject-3.0.1-4e431e92b11a9731636aa1f9c8d1ccbcfdab78df/node_modules/isobject/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
      ]),
    }],
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isobject-2.1.0-f065561096a3f1da2ef46272f815c840d87e0c89/node_modules/isobject/"),
      packageDependencies: new Map([
        ["isarray", "1.0.0"],
        ["isobject", "2.1.0"],
      ]),
    }],
  ])],
  ["repeat-element", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-repeat-element-1.1.3-782e0d825c0c5a3bb39731f84efee6b742e6b1ce/node_modules/repeat-element/"),
      packageDependencies: new Map([
        ["repeat-element", "1.1.3"],
      ]),
    }],
  ])],
  ["snapdragon", new Map([
    ["0.8.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-snapdragon-0.8.2-64922e7c565b0e14204ba1aa7d6964278d25182d/node_modules/snapdragon/"),
      packageDependencies: new Map([
        ["base", "0.11.2"],
        ["debug", "2.6.9"],
        ["define-property", "0.2.5"],
        ["extend-shallow", "2.0.1"],
        ["map-cache", "0.2.2"],
        ["source-map", "0.5.7"],
        ["source-map-resolve", "0.5.2"],
        ["use", "3.1.1"],
        ["snapdragon", "0.8.2"],
      ]),
    }],
  ])],
  ["base", new Map([
    ["0.11.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-base-0.11.2-7bde5ced145b6d551a90db87f83c558b4eb48a8f/node_modules/base/"),
      packageDependencies: new Map([
        ["cache-base", "1.0.1"],
        ["class-utils", "0.3.6"],
        ["component-emitter", "1.2.1"],
        ["define-property", "1.0.0"],
        ["isobject", "3.0.1"],
        ["mixin-deep", "1.3.1"],
        ["pascalcase", "0.1.1"],
        ["base", "0.11.2"],
      ]),
    }],
  ])],
  ["cache-base", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cache-base-1.0.1-0a7f46416831c8b662ee36fe4e7c59d76f666ab2/node_modules/cache-base/"),
      packageDependencies: new Map([
        ["collection-visit", "1.0.0"],
        ["component-emitter", "1.2.1"],
        ["get-value", "2.0.6"],
        ["has-value", "1.0.0"],
        ["isobject", "3.0.1"],
        ["set-value", "2.0.0"],
        ["to-object-path", "0.3.0"],
        ["union-value", "1.0.0"],
        ["unset-value", "1.0.0"],
        ["cache-base", "1.0.1"],
      ]),
    }],
  ])],
  ["collection-visit", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-collection-visit-1.0.0-4bc0373c164bc3291b4d368c829cf1a80a59dca0/node_modules/collection-visit/"),
      packageDependencies: new Map([
        ["map-visit", "1.0.0"],
        ["object-visit", "1.0.1"],
        ["collection-visit", "1.0.0"],
      ]),
    }],
  ])],
  ["map-visit", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-map-visit-1.0.0-ecdca8f13144e660f1b5bd41f12f3479d98dfb8f/node_modules/map-visit/"),
      packageDependencies: new Map([
        ["object-visit", "1.0.1"],
        ["map-visit", "1.0.0"],
      ]),
    }],
  ])],
  ["object-visit", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-visit-1.0.1-f79c4493af0c5377b59fe39d395e41042dd045bb/node_modules/object-visit/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
        ["object-visit", "1.0.1"],
      ]),
    }],
  ])],
  ["component-emitter", new Map([
    ["1.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-component-emitter-1.2.1-137918d6d78283f7df7a6b7c5a63e140e69425e6/node_modules/component-emitter/"),
      packageDependencies: new Map([
        ["component-emitter", "1.2.1"],
      ]),
    }],
  ])],
  ["get-value", new Map([
    ["2.0.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-get-value-2.0.6-dc15ca1c672387ca76bd37ac0a395ba2042a2c28/node_modules/get-value/"),
      packageDependencies: new Map([
        ["get-value", "2.0.6"],
      ]),
    }],
  ])],
  ["has-value", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-value-1.0.0-18b281da585b1c5c51def24c930ed29a0be6b177/node_modules/has-value/"),
      packageDependencies: new Map([
        ["get-value", "2.0.6"],
        ["has-values", "1.0.0"],
        ["isobject", "3.0.1"],
        ["has-value", "1.0.0"],
      ]),
    }],
    ["0.3.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-value-0.3.1-7b1f58bada62ca827ec0a2078025654845995e1f/node_modules/has-value/"),
      packageDependencies: new Map([
        ["get-value", "2.0.6"],
        ["has-values", "0.1.4"],
        ["isobject", "2.1.0"],
        ["has-value", "0.3.1"],
      ]),
    }],
  ])],
  ["has-values", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-values-1.0.0-95b0b63fec2146619a6fe57fe75628d5a39efe4f/node_modules/has-values/"),
      packageDependencies: new Map([
        ["is-number", "3.0.0"],
        ["kind-of", "4.0.0"],
        ["has-values", "1.0.0"],
      ]),
    }],
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-values-0.1.4-6d61de95d91dfca9b9a02089ad384bff8f62b771/node_modules/has-values/"),
      packageDependencies: new Map([
        ["has-values", "0.1.4"],
      ]),
    }],
  ])],
  ["set-value", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-set-value-2.0.0-71ae4a88f0feefbbf52d1ea604f3fb315ebb6274/node_modules/set-value/"),
      packageDependencies: new Map([
        ["extend-shallow", "2.0.1"],
        ["is-extendable", "0.1.1"],
        ["is-plain-object", "2.0.4"],
        ["split-string", "3.1.0"],
        ["set-value", "2.0.0"],
      ]),
    }],
    ["0.4.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-set-value-0.4.3-7db08f9d3d22dc7f78e53af3c3bf4666ecdfccf1/node_modules/set-value/"),
      packageDependencies: new Map([
        ["extend-shallow", "2.0.1"],
        ["is-extendable", "0.1.1"],
        ["is-plain-object", "2.0.4"],
        ["to-object-path", "0.3.0"],
        ["set-value", "0.4.3"],
      ]),
    }],
  ])],
  ["is-plain-object", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-plain-object-2.0.4-2c163b3fafb1b606d9d17928f05c2a1c38e07677/node_modules/is-plain-object/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
        ["is-plain-object", "2.0.4"],
      ]),
    }],
  ])],
  ["split-string", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-split-string-3.1.0-7cb09dda3a86585705c64b39a6466038682e8fe2/node_modules/split-string/"),
      packageDependencies: new Map([
        ["extend-shallow", "3.0.2"],
        ["split-string", "3.1.0"],
      ]),
    }],
  ])],
  ["assign-symbols", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-assign-symbols-1.0.0-59667f41fadd4f20ccbc2bb96b8d4f7f78ec0367/node_modules/assign-symbols/"),
      packageDependencies: new Map([
        ["assign-symbols", "1.0.0"],
      ]),
    }],
  ])],
  ["to-object-path", new Map([
    ["0.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-object-path-0.3.0-297588b7b0e7e0ac08e04e672f85c1f4999e17af/node_modules/to-object-path/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["to-object-path", "0.3.0"],
      ]),
    }],
  ])],
  ["union-value", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-union-value-1.0.0-5c71c34cb5bad5dcebe3ea0cd08207ba5aa1aea4/node_modules/union-value/"),
      packageDependencies: new Map([
        ["arr-union", "3.1.0"],
        ["get-value", "2.0.6"],
        ["is-extendable", "0.1.1"],
        ["set-value", "0.4.3"],
        ["union-value", "1.0.0"],
      ]),
    }],
  ])],
  ["arr-union", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-arr-union-3.1.0-e39b09aea9def866a8f206e288af63919bae39c4/node_modules/arr-union/"),
      packageDependencies: new Map([
        ["arr-union", "3.1.0"],
      ]),
    }],
  ])],
  ["unset-value", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-unset-value-1.0.0-8376873f7d2335179ffb1e6fc3a8ed0dfc8ab559/node_modules/unset-value/"),
      packageDependencies: new Map([
        ["has-value", "0.3.1"],
        ["isobject", "3.0.1"],
        ["unset-value", "1.0.0"],
      ]),
    }],
  ])],
  ["class-utils", new Map([
    ["0.3.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-class-utils-0.3.6-f93369ae8b9a7ce02fd41faad0ca83033190c463/node_modules/class-utils/"),
      packageDependencies: new Map([
        ["arr-union", "3.1.0"],
        ["define-property", "0.2.5"],
        ["isobject", "3.0.1"],
        ["static-extend", "0.1.2"],
        ["class-utils", "0.3.6"],
      ]),
    }],
  ])],
  ["define-property", new Map([
    ["0.2.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-define-property-0.2.5-c35b1ef918ec3c990f9a5bc57be04aacec5c8116/node_modules/define-property/"),
      packageDependencies: new Map([
        ["is-descriptor", "0.1.6"],
        ["define-property", "0.2.5"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-define-property-1.0.0-769ebaaf3f4a63aad3af9e8d304c9bbe79bfb0e6/node_modules/define-property/"),
      packageDependencies: new Map([
        ["is-descriptor", "1.0.2"],
        ["define-property", "1.0.0"],
      ]),
    }],
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-define-property-2.0.2-d459689e8d654ba77e02a817f8710d702cb16e9d/node_modules/define-property/"),
      packageDependencies: new Map([
        ["is-descriptor", "1.0.2"],
        ["isobject", "3.0.1"],
        ["define-property", "2.0.2"],
      ]),
    }],
  ])],
  ["is-descriptor", new Map([
    ["0.1.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-descriptor-0.1.6-366d8240dde487ca51823b1ab9f07a10a78251ca/node_modules/is-descriptor/"),
      packageDependencies: new Map([
        ["is-accessor-descriptor", "0.1.6"],
        ["is-data-descriptor", "0.1.4"],
        ["kind-of", "5.1.0"],
        ["is-descriptor", "0.1.6"],
      ]),
    }],
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-descriptor-1.0.2-3b159746a66604b04f8c81524ba365c5f14d86ec/node_modules/is-descriptor/"),
      packageDependencies: new Map([
        ["is-accessor-descriptor", "1.0.0"],
        ["is-data-descriptor", "1.0.0"],
        ["kind-of", "6.0.2"],
        ["is-descriptor", "1.0.2"],
      ]),
    }],
  ])],
  ["is-accessor-descriptor", new Map([
    ["0.1.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-accessor-descriptor-0.1.6-a9e12cb3ae8d876727eeef3843f8a0897b5c98d6/node_modules/is-accessor-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-accessor-descriptor", "0.1.6"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-accessor-descriptor-1.0.0-169c2f6d3df1f992618072365c9b0ea1f6878656/node_modules/is-accessor-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
        ["is-accessor-descriptor", "1.0.0"],
      ]),
    }],
  ])],
  ["is-data-descriptor", new Map([
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-data-descriptor-0.1.4-0b5ee648388e2c860282e793f1856fec3f301b56/node_modules/is-data-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["is-data-descriptor", "0.1.4"],
      ]),
    }],
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-data-descriptor-1.0.0-d84876321d0e7add03990406abbbbd36ba9268c7/node_modules/is-data-descriptor/"),
      packageDependencies: new Map([
        ["kind-of", "6.0.2"],
        ["is-data-descriptor", "1.0.0"],
      ]),
    }],
  ])],
  ["static-extend", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-static-extend-0.1.2-60809c39cbff55337226fd5e0b520f341f1fb5c6/node_modules/static-extend/"),
      packageDependencies: new Map([
        ["define-property", "0.2.5"],
        ["object-copy", "0.1.0"],
        ["static-extend", "0.1.2"],
      ]),
    }],
  ])],
  ["object-copy", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-copy-0.1.0-7e7d858b781bd7c991a41ba975ed3812754e998c/node_modules/object-copy/"),
      packageDependencies: new Map([
        ["copy-descriptor", "0.1.1"],
        ["define-property", "0.2.5"],
        ["kind-of", "3.2.2"],
        ["object-copy", "0.1.0"],
      ]),
    }],
  ])],
  ["copy-descriptor", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-copy-descriptor-0.1.1-676f6eb3c39997c2ee1ac3a924fd6124748f578d/node_modules/copy-descriptor/"),
      packageDependencies: new Map([
        ["copy-descriptor", "0.1.1"],
      ]),
    }],
  ])],
  ["mixin-deep", new Map([
    ["1.3.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mixin-deep-1.3.1-a49e7268dce1a0d9698e45326c5626df3543d0fe/node_modules/mixin-deep/"),
      packageDependencies: new Map([
        ["for-in", "1.0.2"],
        ["is-extendable", "1.0.1"],
        ["mixin-deep", "1.3.1"],
      ]),
    }],
  ])],
  ["for-in", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-for-in-1.0.2-81068d295a8142ec0ac726c6e2200c30fb6d5e80/node_modules/for-in/"),
      packageDependencies: new Map([
        ["for-in", "1.0.2"],
      ]),
    }],
  ])],
  ["pascalcase", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pascalcase-0.1.1-b363e55e8006ca6fe21784d2db22bd15d7917f14/node_modules/pascalcase/"),
      packageDependencies: new Map([
        ["pascalcase", "0.1.1"],
      ]),
    }],
  ])],
  ["debug", new Map([
    ["2.6.9", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-debug-2.6.9-5d128515df134ff327e90a4c93f4e077a536341f/node_modules/debug/"),
      packageDependencies: new Map([
        ["ms", "2.0.0"],
        ["debug", "2.6.9"],
      ]),
    }],
  ])],
  ["ms", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ms-2.0.0-5608aeadfc00be6c2901df5f9861788de0d597c8/node_modules/ms/"),
      packageDependencies: new Map([
        ["ms", "2.0.0"],
      ]),
    }],
  ])],
  ["map-cache", new Map([
    ["0.2.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-map-cache-0.2.2-c32abd0bd6525d9b051645bb4f26ac5dc98a0dbf/node_modules/map-cache/"),
      packageDependencies: new Map([
        ["map-cache", "0.2.2"],
      ]),
    }],
  ])],
  ["source-map", new Map([
    ["0.5.7", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-0.5.7-8a039d2d1021d22d1ea14c80d8ea468ba2ef3fcc/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.5.7"],
      ]),
    }],
    ["0.6.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-0.6.1-74722af32e9614e9c287a8d0bbde48b5e2f1a263/node_modules/source-map/"),
      packageDependencies: new Map([
        ["source-map", "0.6.1"],
      ]),
    }],
  ])],
  ["source-map-resolve", new Map([
    ["0.5.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-resolve-0.5.2-72e2cc34095543e43b2c62b2c4c10d4a9054f259/node_modules/source-map-resolve/"),
      packageDependencies: new Map([
        ["atob", "2.1.2"],
        ["decode-uri-component", "0.2.0"],
        ["resolve-url", "0.2.1"],
        ["source-map-url", "0.4.0"],
        ["urix", "0.1.0"],
        ["source-map-resolve", "0.5.2"],
      ]),
    }],
  ])],
  ["atob", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-atob-2.1.2-6d9517eb9e030d2436666651e86bd9f6f13533c9/node_modules/atob/"),
      packageDependencies: new Map([
        ["atob", "2.1.2"],
      ]),
    }],
  ])],
  ["decode-uri-component", new Map([
    ["0.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-decode-uri-component-0.2.0-eb3913333458775cb84cd1a1fae062106bb87545/node_modules/decode-uri-component/"),
      packageDependencies: new Map([
        ["decode-uri-component", "0.2.0"],
      ]),
    }],
  ])],
  ["resolve-url", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-resolve-url-0.2.1-2c637fe77c893afd2a663fe21aa9080068e2052a/node_modules/resolve-url/"),
      packageDependencies: new Map([
        ["resolve-url", "0.2.1"],
      ]),
    }],
  ])],
  ["source-map-url", new Map([
    ["0.4.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-url-0.4.0-3e935d7ddd73631b97659956d55128e87b5084a3/node_modules/source-map-url/"),
      packageDependencies: new Map([
        ["source-map-url", "0.4.0"],
      ]),
    }],
  ])],
  ["urix", new Map([
    ["0.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-urix-0.1.0-da937f7a62e21fec1fd18d49b35c2935067a6c72/node_modules/urix/"),
      packageDependencies: new Map([
        ["urix", "0.1.0"],
      ]),
    }],
  ])],
  ["use", new Map([
    ["3.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-use-3.1.1-d50c8cac79a19fbc20f2911f56eb973f4e10070f/node_modules/use/"),
      packageDependencies: new Map([
        ["use", "3.1.1"],
      ]),
    }],
  ])],
  ["snapdragon-node", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-snapdragon-node-2.1.1-6c175f86ff14bdb0724563e8f3c1b021a286853b/node_modules/snapdragon-node/"),
      packageDependencies: new Map([
        ["define-property", "1.0.0"],
        ["isobject", "3.0.1"],
        ["snapdragon-util", "3.0.1"],
        ["snapdragon-node", "2.1.1"],
      ]),
    }],
  ])],
  ["snapdragon-util", new Map([
    ["3.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-snapdragon-util-3.0.1-f956479486f2acd79700693f6f7b805e45ab56e2/node_modules/snapdragon-util/"),
      packageDependencies: new Map([
        ["kind-of", "3.2.2"],
        ["snapdragon-util", "3.0.1"],
      ]),
    }],
  ])],
  ["to-regex", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-regex-3.0.2-13cfdd9b336552f30b51f33a8ae1b42a7a7599ce/node_modules/to-regex/"),
      packageDependencies: new Map([
        ["define-property", "2.0.2"],
        ["extend-shallow", "3.0.2"],
        ["regex-not", "1.0.2"],
        ["safe-regex", "1.1.0"],
        ["to-regex", "3.0.2"],
      ]),
    }],
  ])],
  ["regex-not", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-regex-not-1.0.2-1f4ece27e00b0b65e0247a6810e6a85d83a5752c/node_modules/regex-not/"),
      packageDependencies: new Map([
        ["extend-shallow", "3.0.2"],
        ["safe-regex", "1.1.0"],
        ["regex-not", "1.0.2"],
      ]),
    }],
  ])],
  ["safe-regex", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-safe-regex-1.1.0-40a3669f3b077d1e943d44629e157dd48023bf2e/node_modules/safe-regex/"),
      packageDependencies: new Map([
        ["ret", "0.1.15"],
        ["safe-regex", "1.1.0"],
      ]),
    }],
  ])],
  ["ret", new Map([
    ["0.1.15", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ret-0.1.15-b8a4825d5bdb1fc3f6f53c2bc33f81388681c7bc/node_modules/ret/"),
      packageDependencies: new Map([
        ["ret", "0.1.15"],
      ]),
    }],
  ])],
  ["extglob", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-extglob-2.0.4-ad00fe4dc612a9232e8718711dc5cb5ab0285543/node_modules/extglob/"),
      packageDependencies: new Map([
        ["array-unique", "0.3.2"],
        ["define-property", "1.0.0"],
        ["expand-brackets", "2.1.4"],
        ["extend-shallow", "2.0.1"],
        ["fragment-cache", "0.2.1"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["extglob", "2.0.4"],
      ]),
    }],
  ])],
  ["expand-brackets", new Map([
    ["2.1.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-expand-brackets-2.1.4-b77735e315ce30f6b6eff0f83b04151a22449622/node_modules/expand-brackets/"),
      packageDependencies: new Map([
        ["debug", "2.6.9"],
        ["define-property", "0.2.5"],
        ["extend-shallow", "2.0.1"],
        ["posix-character-classes", "0.1.1"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["expand-brackets", "2.1.4"],
      ]),
    }],
  ])],
  ["posix-character-classes", new Map([
    ["0.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-posix-character-classes-0.1.1-01eac0fe3b5af71a2a6c02feabb8c1fef7e00eab/node_modules/posix-character-classes/"),
      packageDependencies: new Map([
        ["posix-character-classes", "0.1.1"],
      ]),
    }],
  ])],
  ["fragment-cache", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fragment-cache-0.2.1-4290fad27f13e89be7f33799c6bc5a0abfff0d19/node_modules/fragment-cache/"),
      packageDependencies: new Map([
        ["map-cache", "0.2.2"],
        ["fragment-cache", "0.2.1"],
      ]),
    }],
  ])],
  ["nanomatch", new Map([
    ["1.2.13", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-nanomatch-1.2.13-b87a8aa4fc0de8fe6be88895b38983ff265bd119/node_modules/nanomatch/"),
      packageDependencies: new Map([
        ["arr-diff", "4.0.0"],
        ["array-unique", "0.3.2"],
        ["define-property", "2.0.2"],
        ["extend-shallow", "3.0.2"],
        ["fragment-cache", "0.2.1"],
        ["is-windows", "1.0.2"],
        ["kind-of", "6.0.2"],
        ["object.pick", "1.3.0"],
        ["regex-not", "1.0.2"],
        ["snapdragon", "0.8.2"],
        ["to-regex", "3.0.2"],
        ["nanomatch", "1.2.13"],
      ]),
    }],
  ])],
  ["is-windows", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-windows-1.0.2-d1850eb9791ecd18e6182ce12a30f396634bb19d/node_modules/is-windows/"),
      packageDependencies: new Map([
        ["is-windows", "1.0.2"],
      ]),
    }],
  ])],
  ["object.pick", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-pick-1.3.0-87a10ac4c1694bd2e1cbf53591a66141fb5dd747/node_modules/object.pick/"),
      packageDependencies: new Map([
        ["isobject", "3.0.1"],
        ["object.pick", "1.3.0"],
      ]),
    }],
  ])],
  ["mkdirp", new Map([
    ["0.5.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mkdirp-0.5.1-30057438eac6cf7f8c4767f38648d6697d75c903/node_modules/mkdirp/"),
      packageDependencies: new Map([
        ["minimist", "0.0.8"],
        ["mkdirp", "0.5.1"],
      ]),
    }],
  ])],
  ["minimist", new Map([
    ["0.0.8", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimist-0.0.8-857fcabfc3397d2625b8228262e86aa7a011b05d/node_modules/minimist/"),
      packageDependencies: new Map([
        ["minimist", "0.0.8"],
      ]),
    }],
  ])],
  ["neo-async", new Map([
    ["2.6.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-neo-async-2.6.0-b9d15e4d71c6762908654b5183ed38b753340835/node_modules/neo-async/"),
      packageDependencies: new Map([
        ["neo-async", "2.6.0"],
      ]),
    }],
  ])],
  ["node-libs-browser", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-node-libs-browser-2.1.0-5f94263d404f6e44767d726901fff05478d600df/node_modules/node-libs-browser/"),
      packageDependencies: new Map([
        ["assert", "1.4.1"],
        ["browserify-zlib", "0.2.0"],
        ["buffer", "4.9.1"],
        ["console-browserify", "1.1.0"],
        ["constants-browserify", "1.0.0"],
        ["crypto-browserify", "3.12.0"],
        ["domain-browser", "1.2.0"],
        ["events", "1.1.1"],
        ["https-browserify", "1.0.0"],
        ["os-browserify", "0.3.0"],
        ["path-browserify", "0.0.0"],
        ["process", "0.11.10"],
        ["punycode", "1.4.1"],
        ["querystring-es3", "0.2.1"],
        ["readable-stream", "2.3.6"],
        ["stream-browserify", "2.0.1"],
        ["stream-http", "2.8.3"],
        ["string_decoder", "1.1.1"],
        ["timers-browserify", "2.0.10"],
        ["tty-browserify", "0.0.0"],
        ["url", "0.11.0"],
        ["util", "0.10.4"],
        ["vm-browserify", "0.0.4"],
        ["node-libs-browser", "2.1.0"],
      ]),
    }],
  ])],
  ["assert", new Map([
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-assert-1.4.1-99912d591836b5a6f5b345c0f07eefc08fc65d91/node_modules/assert/"),
      packageDependencies: new Map([
        ["util", "0.10.3"],
        ["assert", "1.4.1"],
      ]),
    }],
  ])],
  ["util", new Map([
    ["0.10.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-util-0.10.3-7afb1afe50805246489e3db7fe0ed379336ac0f9/node_modules/util/"),
      packageDependencies: new Map([
        ["inherits", "2.0.1"],
        ["util", "0.10.3"],
      ]),
    }],
    ["0.10.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-util-0.10.4-3aa0125bfe668a4672de58857d3ace27ecb76901/node_modules/util/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["util", "0.10.4"],
      ]),
    }],
  ])],
  ["browserify-zlib", new Map([
    ["0.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-zlib-0.2.0-2869459d9aa3be245fe8fe2ca1f46e2e7f54d73f/node_modules/browserify-zlib/"),
      packageDependencies: new Map([
        ["pako", "1.0.6"],
        ["browserify-zlib", "0.2.0"],
      ]),
    }],
  ])],
  ["pako", new Map([
    ["1.0.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pako-1.0.6-0101211baa70c4bca4a0f63f2206e97b7dfaf258/node_modules/pako/"),
      packageDependencies: new Map([
        ["pako", "1.0.6"],
      ]),
    }],
  ])],
  ["buffer", new Map([
    ["4.9.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-buffer-4.9.1-6d1bb601b07a4efced97094132093027c95bc298/node_modules/buffer/"),
      packageDependencies: new Map([
        ["base64-js", "1.3.0"],
        ["ieee754", "1.1.12"],
        ["isarray", "1.0.0"],
        ["buffer", "4.9.1"],
      ]),
    }],
  ])],
  ["base64-js", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-base64-js-1.3.0-cab1e6118f051095e58b5281aea8c1cd22bfc0e3/node_modules/base64-js/"),
      packageDependencies: new Map([
        ["base64-js", "1.3.0"],
      ]),
    }],
  ])],
  ["ieee754", new Map([
    ["1.1.12", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ieee754-1.1.12-50bf24e5b9c8bb98af4964c941cdb0918da7b60b/node_modules/ieee754/"),
      packageDependencies: new Map([
        ["ieee754", "1.1.12"],
      ]),
    }],
  ])],
  ["console-browserify", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-console-browserify-1.1.0-f0241c45730a9fc6323b206dbf38edc741d0bb10/node_modules/console-browserify/"),
      packageDependencies: new Map([
        ["date-now", "0.1.4"],
        ["console-browserify", "1.1.0"],
      ]),
    }],
  ])],
  ["date-now", new Map([
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-date-now-0.1.4-eaf439fd4d4848ad74e5cc7dbef200672b9e345b/node_modules/date-now/"),
      packageDependencies: new Map([
        ["date-now", "0.1.4"],
      ]),
    }],
  ])],
  ["constants-browserify", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-constants-browserify-1.0.0-c20b96d8c617748aaf1c16021760cd27fcb8cb75/node_modules/constants-browserify/"),
      packageDependencies: new Map([
        ["constants-browserify", "1.0.0"],
      ]),
    }],
  ])],
  ["crypto-browserify", new Map([
    ["3.12.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-crypto-browserify-3.12.0-396cf9f3137f03e4b8e532c58f698254e00f80ec/node_modules/crypto-browserify/"),
      packageDependencies: new Map([
        ["browserify-cipher", "1.0.1"],
        ["browserify-sign", "4.0.4"],
        ["create-ecdh", "4.0.3"],
        ["create-hash", "1.2.0"],
        ["create-hmac", "1.1.7"],
        ["diffie-hellman", "5.0.3"],
        ["inherits", "2.0.3"],
        ["pbkdf2", "3.0.17"],
        ["public-encrypt", "4.0.3"],
        ["randombytes", "2.0.6"],
        ["randomfill", "1.0.4"],
        ["crypto-browserify", "3.12.0"],
      ]),
    }],
  ])],
  ["browserify-cipher", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-cipher-1.0.1-8d6474c1b870bfdabcd3bcfcc1934a10e94f15f0/node_modules/browserify-cipher/"),
      packageDependencies: new Map([
        ["browserify-aes", "1.2.0"],
        ["browserify-des", "1.0.2"],
        ["evp_bytestokey", "1.0.3"],
        ["browserify-cipher", "1.0.1"],
      ]),
    }],
  ])],
  ["browserify-aes", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-aes-1.2.0-326734642f403dabc3003209853bb70ad428ef48/node_modules/browserify-aes/"),
      packageDependencies: new Map([
        ["buffer-xor", "1.0.3"],
        ["cipher-base", "1.0.4"],
        ["create-hash", "1.2.0"],
        ["evp_bytestokey", "1.0.3"],
        ["inherits", "2.0.3"],
        ["safe-buffer", "5.1.2"],
        ["browserify-aes", "1.2.0"],
      ]),
    }],
  ])],
  ["buffer-xor", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-buffer-xor-1.0.3-26e61ed1422fb70dd42e6e36729ed51d855fe8d9/node_modules/buffer-xor/"),
      packageDependencies: new Map([
        ["buffer-xor", "1.0.3"],
      ]),
    }],
  ])],
  ["cipher-base", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cipher-base-1.0.4-8760e4ecc272f4c363532f926d874aae2c1397de/node_modules/cipher-base/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["safe-buffer", "5.1.2"],
        ["cipher-base", "1.0.4"],
      ]),
    }],
  ])],
  ["create-hash", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-create-hash-1.2.0-889078af11a63756bcfb59bd221996be3a9ef196/node_modules/create-hash/"),
      packageDependencies: new Map([
        ["cipher-base", "1.0.4"],
        ["inherits", "2.0.3"],
        ["md5.js", "1.3.5"],
        ["ripemd160", "2.0.2"],
        ["sha.js", "2.4.11"],
        ["create-hash", "1.2.0"],
      ]),
    }],
  ])],
  ["md5.js", new Map([
    ["1.3.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-md5-js-1.3.5-b5d07b8e3216e3e27cd728d72f70d1e6a342005f/node_modules/md5.js/"),
      packageDependencies: new Map([
        ["hash-base", "3.0.4"],
        ["inherits", "2.0.3"],
        ["safe-buffer", "5.1.2"],
        ["md5.js", "1.3.5"],
      ]),
    }],
  ])],
  ["hash-base", new Map([
    ["3.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hash-base-3.0.4-5fc8686847ecd73499403319a6b0a3f3f6ae4918/node_modules/hash-base/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["safe-buffer", "5.1.2"],
        ["hash-base", "3.0.4"],
      ]),
    }],
  ])],
  ["ripemd160", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ripemd160-2.0.2-a1c1a6f624751577ba5d07914cbc92850585890c/node_modules/ripemd160/"),
      packageDependencies: new Map([
        ["hash-base", "3.0.4"],
        ["inherits", "2.0.3"],
        ["ripemd160", "2.0.2"],
      ]),
    }],
  ])],
  ["sha.js", new Map([
    ["2.4.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-sha-js-2.4.11-37a5cf0b81ecbc6943de109ba2960d1b26584ae7/node_modules/sha.js/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["safe-buffer", "5.1.2"],
        ["sha.js", "2.4.11"],
      ]),
    }],
  ])],
  ["evp_bytestokey", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-evp-bytestokey-1.0.3-7fcbdb198dc71959432efe13842684e0525acb02/node_modules/evp_bytestokey/"),
      packageDependencies: new Map([
        ["md5.js", "1.3.5"],
        ["safe-buffer", "5.1.2"],
        ["evp_bytestokey", "1.0.3"],
      ]),
    }],
  ])],
  ["browserify-des", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-des-1.0.2-3af4f1f59839403572f1c66204375f7a7f703e9c/node_modules/browserify-des/"),
      packageDependencies: new Map([
        ["cipher-base", "1.0.4"],
        ["des.js", "1.0.0"],
        ["inherits", "2.0.3"],
        ["safe-buffer", "5.1.2"],
        ["browserify-des", "1.0.2"],
      ]),
    }],
  ])],
  ["des.js", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-des-js-1.0.0-c074d2e2aa6a8a9a07dbd61f9a15c2cd83ec8ecc/node_modules/des.js/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["minimalistic-assert", "1.0.1"],
        ["des.js", "1.0.0"],
      ]),
    }],
  ])],
  ["minimalistic-assert", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimalistic-assert-1.0.1-2e194de044626d4a10e7f7fbc00ce73e83e4d5c7/node_modules/minimalistic-assert/"),
      packageDependencies: new Map([
        ["minimalistic-assert", "1.0.1"],
      ]),
    }],
  ])],
  ["browserify-sign", new Map([
    ["4.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-sign-4.0.4-aa4eb68e5d7b658baa6bf6a57e630cbd7a93d298/node_modules/browserify-sign/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["browserify-rsa", "4.0.1"],
        ["create-hash", "1.2.0"],
        ["create-hmac", "1.1.7"],
        ["elliptic", "6.4.1"],
        ["inherits", "2.0.3"],
        ["parse-asn1", "5.1.1"],
        ["browserify-sign", "4.0.4"],
      ]),
    }],
  ])],
  ["bn.js", new Map([
    ["4.11.8", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-bn-js-4.11.8-2cde09eb5ee341f484746bb0309b3253b1b1442f/node_modules/bn.js/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
      ]),
    }],
  ])],
  ["browserify-rsa", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-rsa-4.0.1-21e0abfaf6f2029cf2fafb133567a701d4135524/node_modules/browserify-rsa/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["randombytes", "2.0.6"],
        ["browserify-rsa", "4.0.1"],
      ]),
    }],
  ])],
  ["randombytes", new Map([
    ["2.0.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-randombytes-2.0.6-d302c522948588848a8d300c932b44c24231da80/node_modules/randombytes/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["randombytes", "2.0.6"],
      ]),
    }],
  ])],
  ["create-hmac", new Map([
    ["1.1.7", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-create-hmac-1.1.7-69170c78b3ab957147b2b8b04572e47ead2243ff/node_modules/create-hmac/"),
      packageDependencies: new Map([
        ["cipher-base", "1.0.4"],
        ["create-hash", "1.2.0"],
        ["inherits", "2.0.3"],
        ["ripemd160", "2.0.2"],
        ["safe-buffer", "5.1.2"],
        ["sha.js", "2.4.11"],
        ["create-hmac", "1.1.7"],
      ]),
    }],
  ])],
  ["elliptic", new Map([
    ["6.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-elliptic-6.4.1-c2d0b7776911b86722c632c3c06c60f2f819939a/node_modules/elliptic/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["brorand", "1.1.0"],
        ["hash.js", "1.1.5"],
        ["hmac-drbg", "1.0.1"],
        ["inherits", "2.0.3"],
        ["minimalistic-assert", "1.0.1"],
        ["minimalistic-crypto-utils", "1.0.1"],
        ["elliptic", "6.4.1"],
      ]),
    }],
  ])],
  ["brorand", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-brorand-1.1.0-12c25efe40a45e3c323eb8675a0a0ce57b22371f/node_modules/brorand/"),
      packageDependencies: new Map([
        ["brorand", "1.1.0"],
      ]),
    }],
  ])],
  ["hash.js", new Map([
    ["1.1.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hash-js-1.1.5-e38ab4b85dfb1e0c40fe9265c0e9b54854c23812/node_modules/hash.js/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["minimalistic-assert", "1.0.1"],
        ["hash.js", "1.1.5"],
      ]),
    }],
  ])],
  ["hmac-drbg", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hmac-drbg-1.0.1-d2745701025a6c775a6c545793ed502fc0c649a1/node_modules/hmac-drbg/"),
      packageDependencies: new Map([
        ["hash.js", "1.1.5"],
        ["minimalistic-assert", "1.0.1"],
        ["minimalistic-crypto-utils", "1.0.1"],
        ["hmac-drbg", "1.0.1"],
      ]),
    }],
  ])],
  ["minimalistic-crypto-utils", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimalistic-crypto-utils-1.0.1-f6c00c1c0b082246e5c4d99dfb8c7c083b2b582a/node_modules/minimalistic-crypto-utils/"),
      packageDependencies: new Map([
        ["minimalistic-crypto-utils", "1.0.1"],
      ]),
    }],
  ])],
  ["parse-asn1", new Map([
    ["5.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-parse-asn1-5.1.1-f6bf293818332bd0dab54efb16087724745e6ca8/node_modules/parse-asn1/"),
      packageDependencies: new Map([
        ["asn1.js", "4.10.1"],
        ["browserify-aes", "1.2.0"],
        ["create-hash", "1.2.0"],
        ["evp_bytestokey", "1.0.3"],
        ["pbkdf2", "3.0.17"],
        ["parse-asn1", "5.1.1"],
      ]),
    }],
  ])],
  ["asn1.js", new Map([
    ["4.10.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-asn1-js-4.10.1-b9c2bf5805f1e64aadeed6df3a2bfafb5a73f5a0/node_modules/asn1.js/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["inherits", "2.0.3"],
        ["minimalistic-assert", "1.0.1"],
        ["asn1.js", "4.10.1"],
      ]),
    }],
  ])],
  ["pbkdf2", new Map([
    ["3.0.17", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pbkdf2-3.0.17-976c206530617b14ebb32114239f7b09336e93a6/node_modules/pbkdf2/"),
      packageDependencies: new Map([
        ["create-hash", "1.2.0"],
        ["create-hmac", "1.1.7"],
        ["ripemd160", "2.0.2"],
        ["safe-buffer", "5.1.2"],
        ["sha.js", "2.4.11"],
        ["pbkdf2", "3.0.17"],
      ]),
    }],
  ])],
  ["create-ecdh", new Map([
    ["4.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-create-ecdh-4.0.3-c9111b6f33045c4697f144787f9254cdc77c45ff/node_modules/create-ecdh/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["elliptic", "6.4.1"],
        ["create-ecdh", "4.0.3"],
      ]),
    }],
  ])],
  ["diffie-hellman", new Map([
    ["5.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-diffie-hellman-5.0.3-40e8ee98f55a2149607146921c63e1ae5f3d2875/node_modules/diffie-hellman/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["miller-rabin", "4.0.1"],
        ["randombytes", "2.0.6"],
        ["diffie-hellman", "5.0.3"],
      ]),
    }],
  ])],
  ["miller-rabin", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-miller-rabin-4.0.1-f080351c865b0dc562a8462966daa53543c78a4d/node_modules/miller-rabin/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["brorand", "1.1.0"],
        ["miller-rabin", "4.0.1"],
      ]),
    }],
  ])],
  ["public-encrypt", new Map([
    ["4.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-public-encrypt-4.0.3-4fcc9d77a07e48ba7527e7cbe0de33d0701331e0/node_modules/public-encrypt/"),
      packageDependencies: new Map([
        ["bn.js", "4.11.8"],
        ["browserify-rsa", "4.0.1"],
        ["create-hash", "1.2.0"],
        ["parse-asn1", "5.1.1"],
        ["randombytes", "2.0.6"],
        ["safe-buffer", "5.1.2"],
        ["public-encrypt", "4.0.3"],
      ]),
    }],
  ])],
  ["randomfill", new Map([
    ["1.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-randomfill-1.0.4-c92196fc86ab42be983f1bf31778224931d61458/node_modules/randomfill/"),
      packageDependencies: new Map([
        ["randombytes", "2.0.6"],
        ["safe-buffer", "5.1.2"],
        ["randomfill", "1.0.4"],
      ]),
    }],
  ])],
  ["domain-browser", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-domain-browser-1.2.0-3d31f50191a6749dd1375a7f522e823d42e54eda/node_modules/domain-browser/"),
      packageDependencies: new Map([
        ["domain-browser", "1.2.0"],
      ]),
    }],
  ])],
  ["events", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-events-1.1.1-9ebdb7635ad099c70dcc4c2a1f5004288e8bd924/node_modules/events/"),
      packageDependencies: new Map([
        ["events", "1.1.1"],
      ]),
    }],
  ])],
  ["https-browserify", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-https-browserify-1.0.0-ec06c10e0a34c0f2faf199f7fd7fc78fffd03c73/node_modules/https-browserify/"),
      packageDependencies: new Map([
        ["https-browserify", "1.0.0"],
      ]),
    }],
  ])],
  ["os-browserify", new Map([
    ["0.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-os-browserify-0.3.0-854373c7f5c2315914fc9bfc6bd8238fdda1ec27/node_modules/os-browserify/"),
      packageDependencies: new Map([
        ["os-browserify", "0.3.0"],
      ]),
    }],
  ])],
  ["path-browserify", new Map([
    ["0.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-browserify-0.0.0-a0b870729aae214005b7d5032ec2cbbb0fb4451a/node_modules/path-browserify/"),
      packageDependencies: new Map([
        ["path-browserify", "0.0.0"],
      ]),
    }],
  ])],
  ["process", new Map([
    ["0.11.10", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-process-0.11.10-7332300e840161bda3e69a1d1d91a7d4bc16f182/node_modules/process/"),
      packageDependencies: new Map([
        ["process", "0.11.10"],
      ]),
    }],
  ])],
  ["querystring-es3", new Map([
    ["0.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-querystring-es3-0.2.1-9ec61f79049875707d69414596fd907a4d711e73/node_modules/querystring-es3/"),
      packageDependencies: new Map([
        ["querystring-es3", "0.2.1"],
      ]),
    }],
  ])],
  ["stream-browserify", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-browserify-2.0.1-66266ee5f9bdb9940a4e4514cafb43bb71e5c9db/node_modules/stream-browserify/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["stream-browserify", "2.0.1"],
      ]),
    }],
  ])],
  ["stream-http", new Map([
    ["2.8.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-http-2.8.3-b2d242469288a5a27ec4fe8933acf623de6514fc/node_modules/stream-http/"),
      packageDependencies: new Map([
        ["builtin-status-codes", "3.0.0"],
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["to-arraybuffer", "1.0.1"],
        ["xtend", "4.0.1"],
        ["stream-http", "2.8.3"],
      ]),
    }],
  ])],
  ["builtin-status-codes", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-builtin-status-codes-3.0.0-85982878e21b98e1c66425e03d0174788f569ee8/node_modules/builtin-status-codes/"),
      packageDependencies: new Map([
        ["builtin-status-codes", "3.0.0"],
      ]),
    }],
  ])],
  ["to-arraybuffer", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-arraybuffer-1.0.1-7d229b1fcc637e466ca081180836a7aabff83f43/node_modules/to-arraybuffer/"),
      packageDependencies: new Map([
        ["to-arraybuffer", "1.0.1"],
      ]),
    }],
  ])],
  ["xtend", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-xtend-4.0.1-a5c6d532be656e23db820efb943a1f04998d63af/node_modules/xtend/"),
      packageDependencies: new Map([
        ["xtend", "4.0.1"],
      ]),
    }],
  ])],
  ["timers-browserify", new Map([
    ["2.0.10", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-timers-browserify-2.0.10-1d28e3d2aadf1d5a5996c4e9f95601cd053480ae/node_modules/timers-browserify/"),
      packageDependencies: new Map([
        ["setimmediate", "1.0.5"],
        ["timers-browserify", "2.0.10"],
      ]),
    }],
  ])],
  ["setimmediate", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-setimmediate-1.0.5-290cbb232e306942d7d7ea9b83732ab7856f8285/node_modules/setimmediate/"),
      packageDependencies: new Map([
        ["setimmediate", "1.0.5"],
      ]),
    }],
  ])],
  ["tty-browserify", new Map([
    ["0.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tty-browserify-0.0.0-a157ba402da24e9bf957f9aa69d524eed42901a6/node_modules/tty-browserify/"),
      packageDependencies: new Map([
        ["tty-browserify", "0.0.0"],
      ]),
    }],
  ])],
  ["url", new Map([
    ["0.11.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-url-0.11.0-3838e97cfc60521eb73c525a8e55bfdd9e2e28f1/node_modules/url/"),
      packageDependencies: new Map([
        ["punycode", "1.3.2"],
        ["querystring", "0.2.0"],
        ["url", "0.11.0"],
      ]),
    }],
  ])],
  ["querystring", new Map([
    ["0.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-querystring-0.2.0-b209849203bb25df820da756e747005878521620/node_modules/querystring/"),
      packageDependencies: new Map([
        ["querystring", "0.2.0"],
      ]),
    }],
  ])],
  ["vm-browserify", new Map([
    ["0.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-vm-browserify-0.0.4-5d7ea45bbef9e4a6ff65f95438e0a87c357d5a73/node_modules/vm-browserify/"),
      packageDependencies: new Map([
        ["indexof", "0.0.1"],
        ["vm-browserify", "0.0.4"],
      ]),
    }],
  ])],
  ["indexof", new Map([
    ["0.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-indexof-0.0.1-82dc336d232b9062179d05ab3293a66059fd435d/node_modules/indexof/"),
      packageDependencies: new Map([
        ["indexof", "0.0.1"],
      ]),
    }],
  ])],
  ["schema-utils", new Map([
    ["0.4.7", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-schema-utils-0.4.7-ba74f597d2be2ea880131746ee17d0a093c68187/node_modules/schema-utils/"),
      packageDependencies: new Map([
        ["ajv", "6.5.5"],
        ["ajv-keywords", "pnp:66d890350fb9581c203378c25d039e96f4f2feb9"],
        ["schema-utils", "0.4.7"],
      ]),
    }],
  ])],
  ["uglifyjs-webpack-plugin", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-uglifyjs-webpack-plugin-1.3.0-75f548160858163a08643e086d5fefe18a5d67de/node_modules/uglifyjs-webpack-plugin/"),
      packageDependencies: new Map([
        ["cacache", "10.0.4"],
        ["find-cache-dir", "1.0.0"],
        ["schema-utils", "0.4.7"],
        ["serialize-javascript", "1.5.0"],
        ["source-map", "0.6.1"],
        ["uglify-es", "3.3.9"],
        ["webpack-sources", "1.3.0"],
        ["worker-farm", "1.6.0"],
        ["uglifyjs-webpack-plugin", "1.3.0"],
      ]),
    }],
  ])],
  ["cacache", new Map([
    ["10.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cacache-10.0.4-6452367999eff9d4188aefd9a14e9d7c6a263460/node_modules/cacache/"),
      packageDependencies: new Map([
        ["bluebird", "3.5.3"],
        ["chownr", "1.1.1"],
        ["glob", "7.1.3"],
        ["graceful-fs", "4.1.15"],
        ["lru-cache", "4.1.3"],
        ["mississippi", "2.0.0"],
        ["mkdirp", "0.5.1"],
        ["move-concurrently", "1.0.1"],
        ["promise-inflight", "1.0.1"],
        ["rimraf", "2.6.2"],
        ["ssri", "5.3.0"],
        ["unique-filename", "1.1.1"],
        ["y18n", "4.0.0"],
        ["cacache", "10.0.4"],
      ]),
    }],
  ])],
  ["bluebird", new Map([
    ["3.5.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-bluebird-3.5.3-7d01c6f9616c9a51ab0f8c549a79dfe6ec33efa7/node_modules/bluebird/"),
      packageDependencies: new Map([
        ["bluebird", "3.5.3"],
      ]),
    }],
  ])],
  ["chownr", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chownr-1.1.1-54726b8b8fff4df053c42187e801fb4412df1494/node_modules/chownr/"),
      packageDependencies: new Map([
        ["chownr", "1.1.1"],
      ]),
    }],
  ])],
  ["glob", new Map([
    ["7.1.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-glob-7.1.3-3960832d3f1574108342dafd3a67b332c0969df1/node_modules/glob/"),
      packageDependencies: new Map([
        ["fs.realpath", "1.0.0"],
        ["inflight", "1.0.6"],
        ["inherits", "2.0.3"],
        ["minimatch", "3.0.4"],
        ["once", "1.4.0"],
        ["path-is-absolute", "1.0.1"],
        ["glob", "7.1.3"],
      ]),
    }],
  ])],
  ["fs.realpath", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fs-realpath-1.0.0-1504ad2523158caa40db4a2787cb01411994ea4f/node_modules/fs.realpath/"),
      packageDependencies: new Map([
        ["fs.realpath", "1.0.0"],
      ]),
    }],
  ])],
  ["inflight", new Map([
    ["1.0.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inflight-1.0.6-49bd6331d7d02d0c09bc910a1075ba8165b56df9/node_modules/inflight/"),
      packageDependencies: new Map([
        ["once", "1.4.0"],
        ["wrappy", "1.0.2"],
        ["inflight", "1.0.6"],
      ]),
    }],
  ])],
  ["once", new Map([
    ["1.4.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-once-1.4.0-583b1aa775961d4b113ac17d9c50baef9dd76bd1/node_modules/once/"),
      packageDependencies: new Map([
        ["wrappy", "1.0.2"],
        ["once", "1.4.0"],
      ]),
    }],
  ])],
  ["wrappy", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-wrappy-1.0.2-b5243d8f3ec1aa35f1364605bc0d1036e30ab69f/node_modules/wrappy/"),
      packageDependencies: new Map([
        ["wrappy", "1.0.2"],
      ]),
    }],
  ])],
  ["minimatch", new Map([
    ["3.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimatch-3.0.4-5166e286457f03306064be5497e8dbb0c3d32083/node_modules/minimatch/"),
      packageDependencies: new Map([
        ["brace-expansion", "1.1.11"],
        ["minimatch", "3.0.4"],
      ]),
    }],
  ])],
  ["brace-expansion", new Map([
    ["1.1.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-brace-expansion-1.1.11-3c7fcbf529d87226f3d2f52b966ff5271eb441dd/node_modules/brace-expansion/"),
      packageDependencies: new Map([
        ["balanced-match", "1.0.0"],
        ["concat-map", "0.0.1"],
        ["brace-expansion", "1.1.11"],
      ]),
    }],
  ])],
  ["balanced-match", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-balanced-match-1.0.0-89b4d199ab2bee49de164ea02b89ce462d71b767/node_modules/balanced-match/"),
      packageDependencies: new Map([
        ["balanced-match", "1.0.0"],
      ]),
    }],
  ])],
  ["concat-map", new Map([
    ["0.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-concat-map-0.0.1-d8a96bd77fd68df7793a73036a3ba0d5405d477b/node_modules/concat-map/"),
      packageDependencies: new Map([
        ["concat-map", "0.0.1"],
      ]),
    }],
  ])],
  ["path-is-absolute", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-is-absolute-1.0.1-174b9268735534ffbc7ace6bf53a5a9e1b5c5f5f/node_modules/path-is-absolute/"),
      packageDependencies: new Map([
        ["path-is-absolute", "1.0.1"],
      ]),
    }],
  ])],
  ["lru-cache", new Map([
    ["4.1.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-lru-cache-4.1.3-a1175cf3496dfc8436c156c334b4955992bce69c/node_modules/lru-cache/"),
      packageDependencies: new Map([
        ["pseudomap", "1.0.2"],
        ["yallist", "2.1.2"],
        ["lru-cache", "4.1.3"],
      ]),
    }],
  ])],
  ["pseudomap", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pseudomap-1.0.2-f052a28da70e618917ef0a8ac34c1ae5a68286b3/node_modules/pseudomap/"),
      packageDependencies: new Map([
        ["pseudomap", "1.0.2"],
      ]),
    }],
  ])],
  ["yallist", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-yallist-2.1.2-1c11f9218f076089a47dd512f93c6699a6a81d52/node_modules/yallist/"),
      packageDependencies: new Map([
        ["yallist", "2.1.2"],
      ]),
    }],
  ])],
  ["mississippi", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mississippi-2.0.0-3442a508fafc28500486feea99409676e4ee5a6f/node_modules/mississippi/"),
      packageDependencies: new Map([
        ["concat-stream", "1.6.2"],
        ["duplexify", "3.6.1"],
        ["end-of-stream", "1.4.1"],
        ["flush-write-stream", "1.0.3"],
        ["from2", "2.3.0"],
        ["parallel-transform", "1.1.0"],
        ["pump", "2.0.1"],
        ["pumpify", "1.5.1"],
        ["stream-each", "1.2.3"],
        ["through2", "2.0.5"],
        ["mississippi", "2.0.0"],
      ]),
    }],
  ])],
  ["concat-stream", new Map([
    ["1.6.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-concat-stream-1.6.2-904bdf194cd3122fc675c77fc4ac3d4ff0fd1a34/node_modules/concat-stream/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["typedarray", "0.0.6"],
        ["concat-stream", "1.6.2"],
      ]),
    }],
  ])],
  ["buffer-from", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-buffer-from-1.1.1-32713bc028f75c02fdb710d7c7bcec1f2c6070ef/node_modules/buffer-from/"),
      packageDependencies: new Map([
        ["buffer-from", "1.1.1"],
      ]),
    }],
  ])],
  ["typedarray", new Map([
    ["0.0.6", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-typedarray-0.0.6-867ac74e3864187b1d3d47d996a78ec5c8830777/node_modules/typedarray/"),
      packageDependencies: new Map([
        ["typedarray", "0.0.6"],
      ]),
    }],
  ])],
  ["duplexify", new Map([
    ["3.6.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-duplexify-3.6.1-b1a7a29c4abfd639585efaecce80d666b1e34125/node_modules/duplexify/"),
      packageDependencies: new Map([
        ["end-of-stream", "1.4.1"],
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["stream-shift", "1.0.0"],
        ["duplexify", "3.6.1"],
      ]),
    }],
  ])],
  ["end-of-stream", new Map([
    ["1.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-end-of-stream-1.4.1-ed29634d19baba463b6ce6b80a37213eab71ec43/node_modules/end-of-stream/"),
      packageDependencies: new Map([
        ["once", "1.4.0"],
        ["end-of-stream", "1.4.1"],
      ]),
    }],
  ])],
  ["stream-shift", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-shift-1.0.0-d5c752825e5367e786f78e18e445ea223a155952/node_modules/stream-shift/"),
      packageDependencies: new Map([
        ["stream-shift", "1.0.0"],
      ]),
    }],
  ])],
  ["flush-write-stream", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-flush-write-stream-1.0.3-c5d586ef38af6097650b49bc41b55fabb19f35bd/node_modules/flush-write-stream/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["flush-write-stream", "1.0.3"],
      ]),
    }],
  ])],
  ["from2", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-from2-2.3.0-8bfb5502bde4a4d36cfdeea007fcca21d7e382af/node_modules/from2/"),
      packageDependencies: new Map([
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["from2", "2.3.0"],
      ]),
    }],
  ])],
  ["parallel-transform", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-parallel-transform-1.1.0-d410f065b05da23081fcd10f28854c29bda33b06/node_modules/parallel-transform/"),
      packageDependencies: new Map([
        ["cyclist", "0.2.2"],
        ["inherits", "2.0.3"],
        ["readable-stream", "2.3.6"],
        ["parallel-transform", "1.1.0"],
      ]),
    }],
  ])],
  ["cyclist", new Map([
    ["0.2.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cyclist-0.2.2-1b33792e11e914a2fd6d6ed6447464444e5fa640/node_modules/cyclist/"),
      packageDependencies: new Map([
        ["cyclist", "0.2.2"],
      ]),
    }],
  ])],
  ["pump", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pump-2.0.1-12399add6e4cf7526d973cbc8b5ce2e2908b3909/node_modules/pump/"),
      packageDependencies: new Map([
        ["end-of-stream", "1.4.1"],
        ["once", "1.4.0"],
        ["pump", "2.0.1"],
      ]),
    }],
  ])],
  ["pumpify", new Map([
    ["1.5.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pumpify-1.5.1-36513be246ab27570b1a374a5ce278bfd74370ce/node_modules/pumpify/"),
      packageDependencies: new Map([
        ["duplexify", "3.6.1"],
        ["inherits", "2.0.3"],
        ["pump", "2.0.1"],
        ["pumpify", "1.5.1"],
      ]),
    }],
  ])],
  ["stream-each", new Map([
    ["1.2.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-each-1.2.3-ebe27a0c389b04fbcc233642952e10731afa9bae/node_modules/stream-each/"),
      packageDependencies: new Map([
        ["end-of-stream", "1.4.1"],
        ["stream-shift", "1.0.0"],
        ["stream-each", "1.2.3"],
      ]),
    }],
  ])],
  ["through2", new Map([
    ["2.0.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-through2-2.0.5-01c1e39eb31d07cb7d03a96a70823260b23132cd/node_modules/through2/"),
      packageDependencies: new Map([
        ["readable-stream", "2.3.6"],
        ["xtend", "4.0.1"],
        ["through2", "2.0.5"],
      ]),
    }],
  ])],
  ["move-concurrently", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-move-concurrently-1.0.1-be2c005fda32e0b29af1f05d7c4b33214c701f92/node_modules/move-concurrently/"),
      packageDependencies: new Map([
        ["aproba", "1.2.0"],
        ["copy-concurrently", "1.0.5"],
        ["fs-write-stream-atomic", "1.0.10"],
        ["mkdirp", "0.5.1"],
        ["rimraf", "2.6.2"],
        ["run-queue", "1.0.3"],
        ["move-concurrently", "1.0.1"],
      ]),
    }],
  ])],
  ["aproba", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-aproba-1.2.0-6802e6264efd18c790a1b0d517f0f2627bf2c94a/node_modules/aproba/"),
      packageDependencies: new Map([
        ["aproba", "1.2.0"],
      ]),
    }],
  ])],
  ["copy-concurrently", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-copy-concurrently-1.0.5-92297398cae34937fcafd6ec8139c18051f0b5e0/node_modules/copy-concurrently/"),
      packageDependencies: new Map([
        ["aproba", "1.2.0"],
        ["fs-write-stream-atomic", "1.0.10"],
        ["iferr", "0.1.5"],
        ["mkdirp", "0.5.1"],
        ["rimraf", "2.6.2"],
        ["run-queue", "1.0.3"],
        ["copy-concurrently", "1.0.5"],
      ]),
    }],
  ])],
  ["fs-write-stream-atomic", new Map([
    ["1.0.10", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fs-write-stream-atomic-1.0.10-b47df53493ef911df75731e70a9ded0189db40c9/node_modules/fs-write-stream-atomic/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["iferr", "0.1.5"],
        ["imurmurhash", "0.1.4"],
        ["readable-stream", "2.3.6"],
        ["fs-write-stream-atomic", "1.0.10"],
      ]),
    }],
  ])],
  ["iferr", new Map([
    ["0.1.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-iferr-0.1.5-c60eed69e6d8fdb6b3104a1fcbca1c192dc5b501/node_modules/iferr/"),
      packageDependencies: new Map([
        ["iferr", "0.1.5"],
      ]),
    }],
  ])],
  ["imurmurhash", new Map([
    ["0.1.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-imurmurhash-0.1.4-9218b9b2b928a238b13dc4fb6b6d576f231453ea/node_modules/imurmurhash/"),
      packageDependencies: new Map([
        ["imurmurhash", "0.1.4"],
      ]),
    }],
  ])],
  ["rimraf", new Map([
    ["2.6.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-rimraf-2.6.2-2ed8150d24a16ea8651e6d6ef0f47c4158ce7a36/node_modules/rimraf/"),
      packageDependencies: new Map([
        ["glob", "7.1.3"],
        ["rimraf", "2.6.2"],
      ]),
    }],
  ])],
  ["run-queue", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-run-queue-1.0.3-e848396f057d223f24386924618e25694161ec47/node_modules/run-queue/"),
      packageDependencies: new Map([
        ["aproba", "1.2.0"],
        ["run-queue", "1.0.3"],
      ]),
    }],
  ])],
  ["promise-inflight", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-promise-inflight-1.0.1-98472870bf228132fcbdd868129bad12c3c029e3/node_modules/promise-inflight/"),
      packageDependencies: new Map([
        ["promise-inflight", "1.0.1"],
      ]),
    }],
  ])],
  ["ssri", new Map([
    ["5.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ssri-5.3.0-ba3872c9c6d33a0704a7d71ff045e5ec48999d06/node_modules/ssri/"),
      packageDependencies: new Map([
        ["safe-buffer", "5.1.2"],
        ["ssri", "5.3.0"],
      ]),
    }],
  ])],
  ["unique-filename", new Map([
    ["1.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-unique-filename-1.1.1-1d69769369ada0583103a1e6ae87681b56573230/node_modules/unique-filename/"),
      packageDependencies: new Map([
        ["unique-slug", "2.0.1"],
        ["unique-filename", "1.1.1"],
      ]),
    }],
  ])],
  ["unique-slug", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-unique-slug-2.0.1-5e9edc6d1ce8fb264db18a507ef9bd8544451ca6/node_modules/unique-slug/"),
      packageDependencies: new Map([
        ["imurmurhash", "0.1.4"],
        ["unique-slug", "2.0.1"],
      ]),
    }],
  ])],
  ["y18n", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-y18n-4.0.0-95ef94f85ecc81d007c264e190a120f0a3c8566b/node_modules/y18n/"),
      packageDependencies: new Map([
        ["y18n", "4.0.0"],
      ]),
    }],
  ])],
  ["find-cache-dir", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-find-cache-dir-1.0.0-9288e3e9e3cc3748717d39eade17cf71fc30ee6f/node_modules/find-cache-dir/"),
      packageDependencies: new Map([
        ["commondir", "1.0.1"],
        ["make-dir", "1.3.0"],
        ["pkg-dir", "2.0.0"],
        ["find-cache-dir", "1.0.0"],
      ]),
    }],
  ])],
  ["commondir", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-commondir-1.0.1-ddd800da0c66127393cca5950ea968a3aaf1253b/node_modules/commondir/"),
      packageDependencies: new Map([
        ["commondir", "1.0.1"],
      ]),
    }],
  ])],
  ["make-dir", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-make-dir-1.3.0-79c1033b80515bd6d24ec9933e860ca75ee27f0c/node_modules/make-dir/"),
      packageDependencies: new Map([
        ["pify", "3.0.0"],
        ["make-dir", "1.3.0"],
      ]),
    }],
  ])],
  ["pify", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pify-3.0.0-e5a4acd2c101fdf3d9a4d07f0dbc4db49dd28176/node_modules/pify/"),
      packageDependencies: new Map([
        ["pify", "3.0.0"],
      ]),
    }],
  ])],
  ["pkg-dir", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pkg-dir-2.0.0-f6d5d1109e19d63edf428e0bd57e12777615334b/node_modules/pkg-dir/"),
      packageDependencies: new Map([
        ["find-up", "2.1.0"],
        ["pkg-dir", "2.0.0"],
      ]),
    }],
  ])],
  ["find-up", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-find-up-2.1.0-45d1b7e506c717ddd482775a2b77920a3c0c57a7/node_modules/find-up/"),
      packageDependencies: new Map([
        ["locate-path", "2.0.0"],
        ["find-up", "2.1.0"],
      ]),
    }],
  ])],
  ["locate-path", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-locate-path-2.0.0-2b568b265eec944c6d9c0de9c3dbbbca0354cd8e/node_modules/locate-path/"),
      packageDependencies: new Map([
        ["p-locate", "2.0.0"],
        ["path-exists", "3.0.0"],
        ["locate-path", "2.0.0"],
      ]),
    }],
  ])],
  ["p-locate", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-locate-2.0.0-20a0103b222a70c8fd39cc2e580680f3dde5ec43/node_modules/p-locate/"),
      packageDependencies: new Map([
        ["p-limit", "1.3.0"],
        ["p-locate", "2.0.0"],
      ]),
    }],
  ])],
  ["p-limit", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-limit-1.3.0-b86bd5f0c25690911c7590fcbfc2010d54b3ccb8/node_modules/p-limit/"),
      packageDependencies: new Map([
        ["p-try", "1.0.0"],
        ["p-limit", "1.3.0"],
      ]),
    }],
  ])],
  ["p-try", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-try-1.0.0-cbc79cdbaf8fd4228e13f621f2b1a237c1b207b3/node_modules/p-try/"),
      packageDependencies: new Map([
        ["p-try", "1.0.0"],
      ]),
    }],
  ])],
  ["path-exists", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-exists-3.0.0-ce0ebeaa5f78cb18925ea7d810d7b59b010fd515/node_modules/path-exists/"),
      packageDependencies: new Map([
        ["path-exists", "3.0.0"],
      ]),
    }],
  ])],
  ["serialize-javascript", new Map([
    ["1.5.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-serialize-javascript-1.5.0-1aa336162c88a890ddad5384baebc93a655161fe/node_modules/serialize-javascript/"),
      packageDependencies: new Map([
        ["serialize-javascript", "1.5.0"],
      ]),
    }],
  ])],
  ["uglify-es", new Map([
    ["3.3.9", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-uglify-es-3.3.9-0c1c4f0700bed8dbc124cdb304d2592ca203e677/node_modules/uglify-es/"),
      packageDependencies: new Map([
        ["commander", "2.13.0"],
        ["source-map", "0.6.1"],
        ["uglify-es", "3.3.9"],
      ]),
    }],
  ])],
  ["commander", new Map([
    ["2.13.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-commander-2.13.0-6964bca67685df7c1f1430c584f07d7597885b9c/node_modules/commander/"),
      packageDependencies: new Map([
        ["commander", "2.13.0"],
      ]),
    }],
  ])],
  ["webpack-sources", new Map([
    ["1.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-webpack-sources-1.3.0-2a28dcb9f1f45fe960d8f1493252b5ee6530fa85/node_modules/webpack-sources/"),
      packageDependencies: new Map([
        ["source-list-map", "2.0.1"],
        ["source-map", "0.6.1"],
        ["webpack-sources", "1.3.0"],
      ]),
    }],
  ])],
  ["source-list-map", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-list-map-2.0.1-3993bd873bfc48479cca9ea3a547835c7c154b34/node_modules/source-list-map/"),
      packageDependencies: new Map([
        ["source-list-map", "2.0.1"],
      ]),
    }],
  ])],
  ["worker-farm", new Map([
    ["1.6.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-worker-farm-1.6.0-aecc405976fab5a95526180846f0dba288f3a4a0/node_modules/worker-farm/"),
      packageDependencies: new Map([
        ["errno", "0.1.7"],
        ["worker-farm", "1.6.0"],
      ]),
    }],
  ])],
  ["watchpack", new Map([
    ["1.6.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-watchpack-1.6.0-4bc12c2ebe8aa277a71f1d3f14d685c7b446cd00/node_modules/watchpack/"),
      packageDependencies: new Map([
        ["chokidar", "2.0.4"],
        ["graceful-fs", "4.1.15"],
        ["neo-async", "2.6.0"],
        ["watchpack", "1.6.0"],
      ]),
    }],
  ])],
  ["chokidar", new Map([
    ["2.0.4", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chokidar-2.0.4-356ff4e2b0e8e43e322d18a372460bbcf3accd26/node_modules/chokidar/"),
      packageDependencies: new Map([
        ["anymatch", "2.0.0"],
        ["async-each", "1.0.1"],
        ["braces", "2.3.2"],
        ["glob-parent", "3.1.0"],
        ["inherits", "2.0.3"],
        ["is-binary-path", "1.0.1"],
        ["is-glob", "4.0.0"],
        ["lodash.debounce", "4.0.8"],
        ["normalize-path", "2.1.1"],
        ["path-is-absolute", "1.0.1"],
        ["readdirp", "2.2.1"],
        ["upath", "1.1.0"],
        ["chokidar", "2.0.4"],
      ]),
    }],
  ])],
  ["anymatch", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-anymatch-2.0.0-bcb24b4f37934d9aa7ac17b4adaf89e7c76ef2eb/node_modules/anymatch/"),
      packageDependencies: new Map([
        ["micromatch", "3.1.10"],
        ["normalize-path", "2.1.1"],
        ["anymatch", "2.0.0"],
      ]),
    }],
  ])],
  ["normalize-path", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-normalize-path-2.1.1-1ab28b556e198363a8c1a6f7e6fa20137fe6aed9/node_modules/normalize-path/"),
      packageDependencies: new Map([
        ["remove-trailing-separator", "1.1.0"],
        ["normalize-path", "2.1.1"],
      ]),
    }],
  ])],
  ["remove-trailing-separator", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-remove-trailing-separator-1.1.0-c24bce2a283adad5bc3f58e0d48249b92379d8ef/node_modules/remove-trailing-separator/"),
      packageDependencies: new Map([
        ["remove-trailing-separator", "1.1.0"],
      ]),
    }],
  ])],
  ["async-each", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-async-each-1.0.1-19d386a1d9edc6e7c1c85d388aedbcc56d33602d/node_modules/async-each/"),
      packageDependencies: new Map([
        ["async-each", "1.0.1"],
      ]),
    }],
  ])],
  ["glob-parent", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-glob-parent-3.1.0-9e6af6299d8d3bd2bd40430832bd113df906c5ae/node_modules/glob-parent/"),
      packageDependencies: new Map([
        ["is-glob", "3.1.0"],
        ["path-dirname", "1.0.2"],
        ["glob-parent", "3.1.0"],
      ]),
    }],
  ])],
  ["is-glob", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-glob-3.1.0-7ba5ae24217804ac70707b96922567486cc3e84a/node_modules/is-glob/"),
      packageDependencies: new Map([
        ["is-extglob", "2.1.1"],
        ["is-glob", "3.1.0"],
      ]),
    }],
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-glob-4.0.0-9521c76845cc2610a85203ddf080a958c2ffabc0/node_modules/is-glob/"),
      packageDependencies: new Map([
        ["is-extglob", "2.1.1"],
        ["is-glob", "4.0.0"],
      ]),
    }],
  ])],
  ["is-extglob", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-extglob-2.1.1-a88c02535791f02ed37c76a1b9ea9773c833f8c2/node_modules/is-extglob/"),
      packageDependencies: new Map([
        ["is-extglob", "2.1.1"],
      ]),
    }],
  ])],
  ["path-dirname", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-dirname-1.0.2-cc33d24d525e099a5388c0336c6e32b9160609e0/node_modules/path-dirname/"),
      packageDependencies: new Map([
        ["path-dirname", "1.0.2"],
      ]),
    }],
  ])],
  ["is-binary-path", new Map([
    ["1.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-binary-path-1.0.1-75f16642b480f187a711c814161fd3a4a7655898/node_modules/is-binary-path/"),
      packageDependencies: new Map([
        ["binary-extensions", "1.12.0"],
        ["is-binary-path", "1.0.1"],
      ]),
    }],
  ])],
  ["binary-extensions", new Map([
    ["1.12.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-binary-extensions-1.12.0-c2d780f53d45bba8317a8902d4ceeaf3a6385b14/node_modules/binary-extensions/"),
      packageDependencies: new Map([
        ["binary-extensions", "1.12.0"],
      ]),
    }],
  ])],
  ["lodash.debounce", new Map([
    ["4.0.8", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-lodash-debounce-4.0.8-82d79bff30a67c4005ffd5e2515300ad9ca4d7af/node_modules/lodash.debounce/"),
      packageDependencies: new Map([
        ["lodash.debounce", "4.0.8"],
      ]),
    }],
  ])],
  ["readdirp", new Map([
    ["2.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-readdirp-2.2.1-0e87622a3325aa33e892285caf8b4e846529a525/node_modules/readdirp/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["micromatch", "3.1.10"],
        ["readable-stream", "2.3.6"],
        ["readdirp", "2.2.1"],
      ]),
    }],
  ])],
  ["upath", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-upath-1.1.0-35256597e46a581db4793d0ce47fa9aebfc9fabd/node_modules/upath/"),
      packageDependencies: new Map([
        ["upath", "1.1.0"],
      ]),
    }],
  ])],
  ["hygen", new Map([
    ["1.6.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hygen-1.6.2-280c38805c4afbfc8717dc2657a009529bc10768/node_modules/hygen/"),
      packageDependencies: new Map([
        ["chalk", "2.4.1"],
        ["ejs", "2.6.1"],
        ["execa", "0.9.0"],
        ["front-matter", "2.3.0"],
        ["fs-extra", "5.0.0"],
        ["inflection", "1.12.0"],
        ["inquirer", "4.0.2"],
        ["lodash", "4.17.11"],
        ["yargs-parser", "7.0.0"],
        ["hygen", "1.6.2"],
      ]),
    }],
  ])],
  ["chalk", new Map([
    ["2.4.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chalk-2.4.1-18c49ab16a037b6eb0152cc83e3471338215b66e/node_modules/chalk/"),
      packageDependencies: new Map([
        ["ansi-styles", "3.2.1"],
        ["escape-string-regexp", "1.0.5"],
        ["supports-color", "5.5.0"],
        ["chalk", "2.4.1"],
      ]),
    }],
  ])],
  ["ansi-styles", new Map([
    ["3.2.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ansi-styles-3.2.1-41fbb20243e50b12be0f04b8dedbf07520ce841d/node_modules/ansi-styles/"),
      packageDependencies: new Map([
        ["color-convert", "1.9.3"],
        ["ansi-styles", "3.2.1"],
      ]),
    }],
  ])],
  ["color-convert", new Map([
    ["1.9.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-color-convert-1.9.3-bb71850690e1f136567de629d2d5471deda4c1e8/node_modules/color-convert/"),
      packageDependencies: new Map([
        ["color-name", "1.1.3"],
        ["color-convert", "1.9.3"],
      ]),
    }],
  ])],
  ["color-name", new Map([
    ["1.1.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-color-name-1.1.3-a7d0558bd89c42f795dd42328f740831ca53bc25/node_modules/color-name/"),
      packageDependencies: new Map([
        ["color-name", "1.1.3"],
      ]),
    }],
  ])],
  ["escape-string-regexp", new Map([
    ["1.0.5", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-escape-string-regexp-1.0.5-1b61c0562190a8dff6ae3bb2cf0200ca130b86d4/node_modules/escape-string-regexp/"),
      packageDependencies: new Map([
        ["escape-string-regexp", "1.0.5"],
      ]),
    }],
  ])],
  ["supports-color", new Map([
    ["5.5.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-supports-color-5.5.0-e2e69a44ac8772f78a1ec0b35b689df6530efc8f/node_modules/supports-color/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
        ["supports-color", "5.5.0"],
      ]),
    }],
  ])],
  ["has-flag", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-flag-3.0.0-b5d454dc2199ae225699f3467e5a07f3b955bafd/node_modules/has-flag/"),
      packageDependencies: new Map([
        ["has-flag", "3.0.0"],
      ]),
    }],
  ])],
  ["ejs", new Map([
    ["2.6.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ejs-2.6.1-498ec0d495655abc6f23cd61868d926464071aa0/node_modules/ejs/"),
      packageDependencies: new Map([
        ["ejs", "2.6.1"],
      ]),
    }],
  ])],
  ["execa", new Map([
    ["0.9.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-execa-0.9.0-adb7ce62cf985071f60580deb4a88b9e34712d01/node_modules/execa/"),
      packageDependencies: new Map([
        ["cross-spawn", "5.1.0"],
        ["get-stream", "3.0.0"],
        ["is-stream", "1.1.0"],
        ["npm-run-path", "2.0.2"],
        ["p-finally", "1.0.0"],
        ["signal-exit", "3.0.2"],
        ["strip-eof", "1.0.0"],
        ["execa", "0.9.0"],
      ]),
    }],
  ])],
  ["cross-spawn", new Map([
    ["5.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cross-spawn-5.1.0-e8bd0efee58fcff6f8f94510a0a554bbfa235449/node_modules/cross-spawn/"),
      packageDependencies: new Map([
        ["lru-cache", "4.1.3"],
        ["shebang-command", "1.2.0"],
        ["which", "1.3.1"],
        ["cross-spawn", "5.1.0"],
      ]),
    }],
  ])],
  ["shebang-command", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-shebang-command-1.2.0-44aac65b695b03398968c39f363fee5deafdf1ea/node_modules/shebang-command/"),
      packageDependencies: new Map([
        ["shebang-regex", "1.0.0"],
        ["shebang-command", "1.2.0"],
      ]),
    }],
  ])],
  ["shebang-regex", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-shebang-regex-1.0.0-da42f49740c0b42db2ca9728571cb190c98efea3/node_modules/shebang-regex/"),
      packageDependencies: new Map([
        ["shebang-regex", "1.0.0"],
      ]),
    }],
  ])],
  ["which", new Map([
    ["1.3.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-which-1.3.1-a45043d54f5805316da8d62f9f50918d3da70b0a/node_modules/which/"),
      packageDependencies: new Map([
        ["isexe", "2.0.0"],
        ["which", "1.3.1"],
      ]),
    }],
  ])],
  ["isexe", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isexe-2.0.0-e8fbf374dc556ff8947a10dcb0572d633f2cfa10/node_modules/isexe/"),
      packageDependencies: new Map([
        ["isexe", "2.0.0"],
      ]),
    }],
  ])],
  ["get-stream", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-get-stream-3.0.0-8e943d1358dc37555054ecbe2edb05aa174ede14/node_modules/get-stream/"),
      packageDependencies: new Map([
        ["get-stream", "3.0.0"],
      ]),
    }],
  ])],
  ["is-stream", new Map([
    ["1.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-stream-1.1.0-12d4a3dd4e68e0b79ceb8dbc84173ae80d91ca44/node_modules/is-stream/"),
      packageDependencies: new Map([
        ["is-stream", "1.1.0"],
      ]),
    }],
  ])],
  ["npm-run-path", new Map([
    ["2.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-npm-run-path-2.0.2-35a9232dfa35d7067b4cb2ddf2357b1871536c5f/node_modules/npm-run-path/"),
      packageDependencies: new Map([
        ["path-key", "2.0.1"],
        ["npm-run-path", "2.0.2"],
      ]),
    }],
  ])],
  ["path-key", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-key-2.0.1-411cadb574c5a140d3a4b1910d40d80cc9f40b40/node_modules/path-key/"),
      packageDependencies: new Map([
        ["path-key", "2.0.1"],
      ]),
    }],
  ])],
  ["p-finally", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-finally-1.0.0-3fbcfb15b899a44123b34b6dcc18b724336a2cae/node_modules/p-finally/"),
      packageDependencies: new Map([
        ["p-finally", "1.0.0"],
      ]),
    }],
  ])],
  ["signal-exit", new Map([
    ["3.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-signal-exit-3.0.2-b5fdc08f1287ea1178628e415e25132b73646c6d/node_modules/signal-exit/"),
      packageDependencies: new Map([
        ["signal-exit", "3.0.2"],
      ]),
    }],
  ])],
  ["strip-eof", new Map([
    ["1.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-strip-eof-1.0.0-bb43ff5598a6eb05d89b59fcd129c983313606bf/node_modules/strip-eof/"),
      packageDependencies: new Map([
        ["strip-eof", "1.0.0"],
      ]),
    }],
  ])],
  ["front-matter", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-front-matter-2.3.0-7203af896ce357ee04e2aa45169ea91ed7f67504/node_modules/front-matter/"),
      packageDependencies: new Map([
        ["js-yaml", "3.12.0"],
        ["front-matter", "2.3.0"],
      ]),
    }],
  ])],
  ["js-yaml", new Map([
    ["3.12.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-js-yaml-3.12.0-eaed656ec8344f10f527c6bfa1b6e2244de167d1/node_modules/js-yaml/"),
      packageDependencies: new Map([
        ["argparse", "1.0.10"],
        ["esprima", "4.0.1"],
        ["js-yaml", "3.12.0"],
      ]),
    }],
  ])],
  ["argparse", new Map([
    ["1.0.10", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-argparse-1.0.10-bcd6791ea5ae09725e17e5ad988134cd40b3d911/node_modules/argparse/"),
      packageDependencies: new Map([
        ["sprintf-js", "1.0.3"],
        ["argparse", "1.0.10"],
      ]),
    }],
  ])],
  ["sprintf-js", new Map([
    ["1.0.3", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-sprintf-js-1.0.3-04e6926f662895354f3dd015203633b857297e2c/node_modules/sprintf-js/"),
      packageDependencies: new Map([
        ["sprintf-js", "1.0.3"],
      ]),
    }],
  ])],
  ["esprima", new Map([
    ["4.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-esprima-4.0.1-13b04cdb3e6c5d19df91ab6987a8695619b0aa71/node_modules/esprima/"),
      packageDependencies: new Map([
        ["esprima", "4.0.1"],
      ]),
    }],
  ])],
  ["fs-extra", new Map([
    ["5.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fs-extra-5.0.0-414d0110cdd06705734d055652c5411260c31abd/node_modules/fs-extra/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["jsonfile", "4.0.0"],
        ["universalify", "0.1.2"],
        ["fs-extra", "5.0.0"],
      ]),
    }],
  ])],
  ["jsonfile", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-jsonfile-4.0.0-8771aae0799b64076b76640fca058f9c10e33ecb/node_modules/jsonfile/"),
      packageDependencies: new Map([
        ["graceful-fs", "4.1.15"],
        ["jsonfile", "4.0.0"],
      ]),
    }],
  ])],
  ["universalify", new Map([
    ["0.1.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-universalify-0.1.2-b646f69be3942dabcecc9d6639c80dc105efaa66/node_modules/universalify/"),
      packageDependencies: new Map([
        ["universalify", "0.1.2"],
      ]),
    }],
  ])],
  ["inflection", new Map([
    ["1.12.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inflection-1.12.0-a200935656d6f5f6bc4dc7502e1aecb703228416/node_modules/inflection/"),
      packageDependencies: new Map([
        ["inflection", "1.12.0"],
      ]),
    }],
  ])],
  ["inquirer", new Map([
    ["4.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inquirer-4.0.2-cc678b4cbc0e183a3500cc63395831ec956ab0a3/node_modules/inquirer/"),
      packageDependencies: new Map([
        ["ansi-escapes", "3.1.0"],
        ["chalk", "2.4.1"],
        ["cli-cursor", "2.1.0"],
        ["cli-width", "2.2.0"],
        ["external-editor", "2.2.0"],
        ["figures", "2.0.0"],
        ["lodash", "4.17.11"],
        ["mute-stream", "0.0.7"],
        ["run-async", "2.3.0"],
        ["rx-lite", "4.0.8"],
        ["rx-lite-aggregates", "4.0.8"],
        ["string-width", "2.1.1"],
        ["strip-ansi", "4.0.0"],
        ["through", "2.3.8"],
        ["inquirer", "4.0.2"],
      ]),
    }],
  ])],
  ["ansi-escapes", new Map([
    ["3.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ansi-escapes-3.1.0-f73207bb81207d75fd6c83f125af26eea378ca30/node_modules/ansi-escapes/"),
      packageDependencies: new Map([
        ["ansi-escapes", "3.1.0"],
      ]),
    }],
  ])],
  ["cli-cursor", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cli-cursor-2.1.0-b35dac376479facc3e94747d41d0d0f5238ffcb5/node_modules/cli-cursor/"),
      packageDependencies: new Map([
        ["restore-cursor", "2.0.0"],
        ["cli-cursor", "2.1.0"],
      ]),
    }],
  ])],
  ["restore-cursor", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-restore-cursor-2.0.0-9f7ee287f82fd326d4fd162923d62129eee0dfaf/node_modules/restore-cursor/"),
      packageDependencies: new Map([
        ["onetime", "2.0.1"],
        ["signal-exit", "3.0.2"],
        ["restore-cursor", "2.0.0"],
      ]),
    }],
  ])],
  ["onetime", new Map([
    ["2.0.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-onetime-2.0.1-067428230fd67443b2794b22bba528b6867962d4/node_modules/onetime/"),
      packageDependencies: new Map([
        ["mimic-fn", "1.2.0"],
        ["onetime", "2.0.1"],
      ]),
    }],
  ])],
  ["mimic-fn", new Map([
    ["1.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mimic-fn-1.2.0-820c86a39334640e99516928bd03fca88057d022/node_modules/mimic-fn/"),
      packageDependencies: new Map([
        ["mimic-fn", "1.2.0"],
      ]),
    }],
  ])],
  ["cli-width", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cli-width-2.2.0-ff19ede8a9a5e579324147b0c11f0fbcbabed639/node_modules/cli-width/"),
      packageDependencies: new Map([
        ["cli-width", "2.2.0"],
      ]),
    }],
  ])],
  ["external-editor", new Map([
    ["2.2.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-external-editor-2.2.0-045511cfd8d133f3846673d1047c154e214ad3d5/node_modules/external-editor/"),
      packageDependencies: new Map([
        ["chardet", "0.4.2"],
        ["iconv-lite", "0.4.24"],
        ["tmp", "0.0.33"],
        ["external-editor", "2.2.0"],
      ]),
    }],
  ])],
  ["chardet", new Map([
    ["0.4.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chardet-0.4.2-b5473b33dc97c424e5d98dc87d55d4d8a29c8bf2/node_modules/chardet/"),
      packageDependencies: new Map([
        ["chardet", "0.4.2"],
      ]),
    }],
  ])],
  ["iconv-lite", new Map([
    ["0.4.24", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-iconv-lite-0.4.24-2022b4b25fbddc21d2f524974a474aafe733908b/node_modules/iconv-lite/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
        ["iconv-lite", "0.4.24"],
      ]),
    }],
  ])],
  ["safer-buffer", new Map([
    ["2.1.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-safer-buffer-2.1.2-44fa161b0187b9549dd84bb91802f9bd8385cd6a/node_modules/safer-buffer/"),
      packageDependencies: new Map([
        ["safer-buffer", "2.1.2"],
      ]),
    }],
  ])],
  ["tmp", new Map([
    ["0.0.33", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tmp-0.0.33-6d34335889768d21b2bcda0aa277ced3b1bfadf9/node_modules/tmp/"),
      packageDependencies: new Map([
        ["os-tmpdir", "1.0.2"],
        ["tmp", "0.0.33"],
      ]),
    }],
  ])],
  ["os-tmpdir", new Map([
    ["1.0.2", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-os-tmpdir-1.0.2-bbe67406c79aa85c5cfec766fe5734555dfa1274/node_modules/os-tmpdir/"),
      packageDependencies: new Map([
        ["os-tmpdir", "1.0.2"],
      ]),
    }],
  ])],
  ["figures", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-figures-2.0.0-3ab1a2d2a62c8bfb431a0c94cb797a2fce27c962/node_modules/figures/"),
      packageDependencies: new Map([
        ["escape-string-regexp", "1.0.5"],
        ["figures", "2.0.0"],
      ]),
    }],
  ])],
  ["lodash", new Map([
    ["4.17.11", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-lodash-4.17.11-b39ea6229ef607ecd89e2c8df12536891cac9b8d/node_modules/lodash/"),
      packageDependencies: new Map([
        ["lodash", "4.17.11"],
      ]),
    }],
  ])],
  ["mute-stream", new Map([
    ["0.0.7", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mute-stream-0.0.7-3075ce93bc21b8fab43e1bc4da7e8115ed1e7bab/node_modules/mute-stream/"),
      packageDependencies: new Map([
        ["mute-stream", "0.0.7"],
      ]),
    }],
  ])],
  ["run-async", new Map([
    ["2.3.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-run-async-2.3.0-0371ab4ae0bdd720d4166d7dfda64ff7a445a6c0/node_modules/run-async/"),
      packageDependencies: new Map([
        ["is-promise", "2.1.0"],
        ["run-async", "2.3.0"],
      ]),
    }],
  ])],
  ["is-promise", new Map([
    ["2.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-promise-2.1.0-79a2a9ece7f096e80f36d2b2f3bc16c1ff4bf3fa/node_modules/is-promise/"),
      packageDependencies: new Map([
        ["is-promise", "2.1.0"],
      ]),
    }],
  ])],
  ["rx-lite", new Map([
    ["4.0.8", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-rx-lite-4.0.8-0b1e11af8bc44836f04a6407e92da42467b79444/node_modules/rx-lite/"),
      packageDependencies: new Map([
        ["rx-lite", "4.0.8"],
      ]),
    }],
  ])],
  ["rx-lite-aggregates", new Map([
    ["4.0.8", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-rx-lite-aggregates-4.0.8-753b87a89a11c95467c4ac1626c4efc4e05c67be/node_modules/rx-lite-aggregates/"),
      packageDependencies: new Map([
        ["rx-lite", "4.0.8"],
        ["rx-lite-aggregates", "4.0.8"],
      ]),
    }],
  ])],
  ["string-width", new Map([
    ["2.1.1", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-string-width-2.1.1-ab93f27a8dc13d28cac815c462143a6d9012ae9e/node_modules/string-width/"),
      packageDependencies: new Map([
        ["is-fullwidth-code-point", "2.0.0"],
        ["strip-ansi", "4.0.0"],
        ["string-width", "2.1.1"],
      ]),
    }],
  ])],
  ["is-fullwidth-code-point", new Map([
    ["2.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-fullwidth-code-point-2.0.0-a3b30a5c4f199183167aaab93beefae3ddfb654f/node_modules/is-fullwidth-code-point/"),
      packageDependencies: new Map([
        ["is-fullwidth-code-point", "2.0.0"],
      ]),
    }],
  ])],
  ["strip-ansi", new Map([
    ["4.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-strip-ansi-4.0.0-a8479022eb1ac368a871389b635262c505ee368f/node_modules/strip-ansi/"),
      packageDependencies: new Map([
        ["ansi-regex", "3.0.0"],
        ["strip-ansi", "4.0.0"],
      ]),
    }],
  ])],
  ["ansi-regex", new Map([
    ["3.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ansi-regex-3.0.0-ed0317c322064f79466c02966bddb605ab37d998/node_modules/ansi-regex/"),
      packageDependencies: new Map([
        ["ansi-regex", "3.0.0"],
      ]),
    }],
  ])],
  ["through", new Map([
    ["2.3.8", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-through-2.3.8-0dd4c9ffaabc357960b1b724115d7e0e86a2e1f5/node_modules/through/"),
      packageDependencies: new Map([
        ["through", "2.3.8"],
      ]),
    }],
  ])],
  ["yargs-parser", new Map([
    ["7.0.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-yargs-parser-7.0.0-8d0ac42f16ea55debd332caf4c4038b3e3f5dfd9/node_modules/yargs-parser/"),
      packageDependencies: new Map([
        ["camelcase", "4.1.0"],
        ["yargs-parser", "7.0.0"],
      ]),
    }],
  ])],
  ["camelcase", new Map([
    ["4.1.0", {
      packageLocation: path.resolve(__dirname, "../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-camelcase-4.1.0-d545635be1e33c542649c69173e5de6acfae34dd/node_modules/camelcase/"),
      packageDependencies: new Map([
        ["camelcase", "4.1.0"],
      ]),
    }],
  ])],
  [null, new Map([
    [null, {
      packageLocation: path.resolve(__dirname, "./"),
      packageDependencies: new Map([
        ["react", "16.7.0-alpha.0"],
        ["webpack", "4.25.1"],
        ["hygen", "1.6.2"],
      ]),
    }],
  ])],
]);

let locatorsByLocations = new Map([
  ["./.pnp/externals/pnp-d710ebf99eab5562e4c283c79cc171136f17afad/node_modules/ajv-keywords/", blacklistedLocator],
  ["./.pnp/externals/pnp-66d890350fb9581c203378c25d039e96f4f2feb9/node_modules/ajv-keywords/", blacklistedLocator],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-react-16.7.0-alpha.0-e2ed4abe6f268c9b092a1d1e572953684d1783a9/node_modules/react/", {"name":"react","reference":"16.7.0-alpha.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-loose-envify-1.4.0-71ee51fa7be4caec1a63839f7e682d8132d30caf/node_modules/loose-envify/", {"name":"loose-envify","reference":"1.4.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-js-tokens-4.0.0-19203fb59991df98e3a287050d4647cdeaf32499/node_modules/js-tokens/", {"name":"js-tokens","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-assign-4.1.1-2109adc7965887cfc05cbbd442cac8bfbb360863/node_modules/object-assign/", {"name":"object-assign","reference":"4.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-prop-types-15.6.2-05d5ca77b4453e985d60fc7ff8c859094a497102/node_modules/prop-types/", {"name":"prop-types","reference":"15.6.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-scheduler-0.11.0-def1f1bfa6550cc57981a87106e65e8aea41a6b5/node_modules/scheduler/", {"name":"scheduler","reference":"0.11.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-webpack-4.25.1-4f459fbaea0f93440dc86c89f771bb3a837cfb6d/node_modules/webpack/", {"name":"webpack","reference":"4.25.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-ast-1.7.11-b988582cafbb2b095e8b556526f30c90d057cace/node_modules/@webassemblyjs/ast/", {"name":"@webassemblyjs/ast","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-module-context-1.7.11-d874d722e51e62ac202476935d649c802fa0e209/node_modules/@webassemblyjs/helper-module-context/", {"name":"@webassemblyjs/helper-module-context","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-wasm-bytecode-1.7.11-dd9a1e817f1c2eb105b4cf1013093cb9f3c9cb06/node_modules/@webassemblyjs/helper-wasm-bytecode/", {"name":"@webassemblyjs/helper-wasm-bytecode","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wast-parser-1.7.11-25bd117562ca8c002720ff8116ef9072d9ca869c/node_modules/@webassemblyjs/wast-parser/", {"name":"@webassemblyjs/wast-parser","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-floating-point-hex-parser-1.7.11-a69f0af6502eb9a3c045555b1a6129d3d3f2e313/node_modules/@webassemblyjs/floating-point-hex-parser/", {"name":"@webassemblyjs/floating-point-hex-parser","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-api-error-1.7.11-c7b6bb8105f84039511a2b39ce494f193818a32a/node_modules/@webassemblyjs/helper-api-error/", {"name":"@webassemblyjs/helper-api-error","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-code-frame-1.7.11-cf8f106e746662a0da29bdef635fcd3d1248364b/node_modules/@webassemblyjs/helper-code-frame/", {"name":"@webassemblyjs/helper-code-frame","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wast-printer-1.7.11-c4245b6de242cb50a2cc950174fdbf65c78d7813/node_modules/@webassemblyjs/wast-printer/", {"name":"@webassemblyjs/wast-printer","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@xtuc-long-4.2.1-5c85d662f76fa1d34575766c5dcd6615abcd30d8/node_modules/@xtuc/long/", {"name":"@xtuc/long","reference":"4.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-fsm-1.7.11-df38882a624080d03f7503f93e3f17ac5ac01181/node_modules/@webassemblyjs/helper-fsm/", {"name":"@webassemblyjs/helper-fsm","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-edit-1.7.11-8c74ca474d4f951d01dbae9bd70814ee22a82005/node_modules/@webassemblyjs/wasm-edit/", {"name":"@webassemblyjs/wasm-edit","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-buffer-1.7.11-3122d48dcc6c9456ed982debe16c8f37101df39b/node_modules/@webassemblyjs/helper-buffer/", {"name":"@webassemblyjs/helper-buffer","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-helper-wasm-section-1.7.11-9c9ac41ecf9fbcfffc96f6d2675e2de33811e68a/node_modules/@webassemblyjs/helper-wasm-section/", {"name":"@webassemblyjs/helper-wasm-section","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-gen-1.7.11-9bbba942f22375686a6fb759afcd7ac9c45da1a8/node_modules/@webassemblyjs/wasm-gen/", {"name":"@webassemblyjs/wasm-gen","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-ieee754-1.7.11-c95839eb63757a31880aaec7b6512d4191ac640b/node_modules/@webassemblyjs/ieee754/", {"name":"@webassemblyjs/ieee754","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@xtuc-ieee754-1.2.0-eef014a3145ae477a1cbc00cd1e552336dceb790/node_modules/@xtuc/ieee754/", {"name":"@xtuc/ieee754","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-leb128-1.7.11-d7267a1ee9c4594fd3f7e37298818ec65687db63/node_modules/@webassemblyjs/leb128/", {"name":"@webassemblyjs/leb128","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-utf8-1.7.11-06d7218ea9fdc94a6793aa92208160db3d26ee82/node_modules/@webassemblyjs/utf8/", {"name":"@webassemblyjs/utf8","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-opt-1.7.11-b331e8e7cef8f8e2f007d42c3a36a0580a7d6ca7/node_modules/@webassemblyjs/wasm-opt/", {"name":"@webassemblyjs/wasm-opt","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-@webassemblyjs-wasm-parser-1.7.11-6e3d20fa6a3519f6b084ef9391ad58211efb0a1a/node_modules/@webassemblyjs/wasm-parser/", {"name":"@webassemblyjs/wasm-parser","reference":"1.7.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-acorn-5.7.3-67aa231bf8812974b85235a96771eb6bd07ea279/node_modules/acorn/", {"name":"acorn","reference":"5.7.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-acorn-dynamic-import-3.0.0-901ceee4c7faaef7e07ad2a47e890675da50a278/node_modules/acorn-dynamic-import/", {"name":"acorn-dynamic-import","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ajv-6.5.5-cf97cdade71c6399a92c6d6c4177381291b781a1/node_modules/ajv/", {"name":"ajv","reference":"6.5.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fast-deep-equal-2.0.1-7b05218ddf9667bf7f370bf7fdb2cb15fdd0aa49/node_modules/fast-deep-equal/", {"name":"fast-deep-equal","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fast-json-stable-stringify-2.0.0-d5142c0caee6b1189f87d3a76111064f86c8bbf2/node_modules/fast-json-stable-stringify/", {"name":"fast-json-stable-stringify","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-json-schema-traverse-0.4.1-69f6a87d9513ab8bb8fe63bdb0979c448e684660/node_modules/json-schema-traverse/", {"name":"json-schema-traverse","reference":"0.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-uri-js-4.2.2-94c540e1ff772956e2299507c010aea6c8838eb0/node_modules/uri-js/", {"name":"uri-js","reference":"4.2.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-punycode-2.1.1-b58b010ac40c22c5657616c8d2c2c02c7bf479ec/node_modules/punycode/", {"name":"punycode","reference":"2.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-punycode-1.4.1-c0d5a63b2718800ad8e1eb0fa5269c84dd41845e/node_modules/punycode/", {"name":"punycode","reference":"1.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-punycode-1.3.2-9653a036fb7c1ee42342f2325cceefea3926c48d/node_modules/punycode/", {"name":"punycode","reference":"1.3.2"}],
  ["./.pnp/externals/pnp-d710ebf99eab5562e4c283c79cc171136f17afad/node_modules/ajv-keywords/", {"name":"ajv-keywords","reference":"pnp:d710ebf99eab5562e4c283c79cc171136f17afad"}],
  ["./.pnp/externals/pnp-66d890350fb9581c203378c25d039e96f4f2feb9/node_modules/ajv-keywords/", {"name":"ajv-keywords","reference":"pnp:66d890350fb9581c203378c25d039e96f4f2feb9"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chrome-trace-event-1.0.0-45a91bd2c20c9411f0963b5aaeb9a1b95e09cc48/node_modules/chrome-trace-event/", {"name":"chrome-trace-event","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tslib-1.9.3-d7e4dd79245d85428c4d7e4822a79917954ca286/node_modules/tslib/", {"name":"tslib","reference":"1.9.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-enhanced-resolve-4.1.0-41c7e0bfdfe74ac1ffe1e57ad6a5c6c9f3742a7f/node_modules/enhanced-resolve/", {"name":"enhanced-resolve","reference":"4.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-graceful-fs-4.1.15-ffb703e1066e8a0eeaa4c8b80ba9253eeefbfb00/node_modules/graceful-fs/", {"name":"graceful-fs","reference":"4.1.15"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-memory-fs-0.4.1-3a9a20b8462523e447cfbc7e8bb80ed667bfc552/node_modules/memory-fs/", {"name":"memory-fs","reference":"0.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-errno-0.1.7-4684d71779ad39af177e3f007996f7c67c852618/node_modules/errno/", {"name":"errno","reference":"0.1.7"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-prr-1.0.1-d3fc114ba06995a45ec6893f484ceb1d78f5f476/node_modules/prr/", {"name":"prr","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-readable-stream-2.3.6-b11c27d88b8ff1fbe070643cf94b0c79ae1b0aaf/node_modules/readable-stream/", {"name":"readable-stream","reference":"2.3.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-core-util-is-1.0.2-b5fd54220aa2bc5ab57aab7140c940754503c1a7/node_modules/core-util-is/", {"name":"core-util-is","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inherits-2.0.3-633c2c83e3da42a502f52466022480f4208261de/node_modules/inherits/", {"name":"inherits","reference":"2.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inherits-2.0.1-b17d08d326b4423e568eff719f91b0b1cbdf69f1/node_modules/inherits/", {"name":"inherits","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isarray-1.0.0-bb935d48582cba168c06834957a54a3e07124f11/node_modules/isarray/", {"name":"isarray","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-process-nextick-args-2.0.0-a37d732f4271b4ab1ad070d35508e8290788ffaa/node_modules/process-nextick-args/", {"name":"process-nextick-args","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-safe-buffer-5.1.2-991ec69d296e0313747d59bdfd2b745c35f8828d/node_modules/safe-buffer/", {"name":"safe-buffer","reference":"5.1.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-string-decoder-1.1.1-9cf1611ba62685d7030ae9e4ba34149c3af03fc8/node_modules/string_decoder/", {"name":"string_decoder","reference":"1.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-util-deprecate-1.0.2-450d4dc9fa70de732762fbd2d4a28981419a0ccf/node_modules/util-deprecate/", {"name":"util-deprecate","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tapable-1.1.0-0d076a172e3d9ba088fd2272b2668fb8d194b78c/node_modules/tapable/", {"name":"tapable","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-eslint-scope-4.0.0-50bf3071e9338bcdc43331794a0cb533f0136172/node_modules/eslint-scope/", {"name":"eslint-scope","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-esrecurse-4.2.1-007a3b9fdbc2b3bb87e4879ea19c92fdbd3942cf/node_modules/esrecurse/", {"name":"esrecurse","reference":"4.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-estraverse-4.2.0-0dee3fed31fcd469618ce7342099fc1afa0bdb13/node_modules/estraverse/", {"name":"estraverse","reference":"4.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-json-parse-better-errors-1.0.2-bb867cfb3450e69107c131d1c514bab3dc8bcaa9/node_modules/json-parse-better-errors/", {"name":"json-parse-better-errors","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-loader-runner-2.3.1-026f12fe7c3115992896ac02ba022ba92971b979/node_modules/loader-runner/", {"name":"loader-runner","reference":"2.3.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-loader-utils-1.1.0-c98aef488bcceda2ffb5e2de646d6a754429f5cd/node_modules/loader-utils/", {"name":"loader-utils","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-big-js-3.2.0-a5fc298b81b9e0dca2e458824784b65c52ba588e/node_modules/big.js/", {"name":"big.js","reference":"3.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-emojis-list-2.1.0-4daa4d9db00f9819880c79fa457ae5b09a1fd389/node_modules/emojis-list/", {"name":"emojis-list","reference":"2.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-json5-0.5.1-1eade7acc012034ad84e2396767ead9fa5495821/node_modules/json5/", {"name":"json5","reference":"0.5.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-micromatch-3.1.10-70859bc95c9840952f359a068a3fc49f9ecfac23/node_modules/micromatch/", {"name":"micromatch","reference":"3.1.10"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-arr-diff-4.0.0-d6461074febfec71e7e15235761a329a5dc7c520/node_modules/arr-diff/", {"name":"arr-diff","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-array-unique-0.3.2-a894b75d4bc4f6cd679ef3244a9fd8f46ae2d428/node_modules/array-unique/", {"name":"array-unique","reference":"0.3.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-braces-2.3.2-5979fd3f14cd531565e5fa2df1abfff1dfaee729/node_modules/braces/", {"name":"braces","reference":"2.3.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-arr-flatten-1.1.0-36048bbff4e7b47e136644316c99669ea5ae91f1/node_modules/arr-flatten/", {"name":"arr-flatten","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-extend-shallow-2.0.1-51af7d614ad9a9f610ea1bafbb989d6b1c56890f/node_modules/extend-shallow/", {"name":"extend-shallow","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-extend-shallow-3.0.2-26a71aaf073b39fb2127172746131c2704028db8/node_modules/extend-shallow/", {"name":"extend-shallow","reference":"3.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-extendable-0.1.1-62b110e289a471418e3ec36a617d472e301dfc89/node_modules/is-extendable/", {"name":"is-extendable","reference":"0.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-extendable-1.0.1-a7470f9e426733d81bd81e1155264e3a3507cab4/node_modules/is-extendable/", {"name":"is-extendable","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fill-range-4.0.0-d544811d428f98eb06a63dc402d2403c328c38f7/node_modules/fill-range/", {"name":"fill-range","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-number-3.0.0-24fd6201a4782cf50561c810276afc7d12d71195/node_modules/is-number/", {"name":"is-number","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-3.2.2-31ea21a734bab9bbb0f32466d893aea51e4a3c64/node_modules/kind-of/", {"name":"kind-of","reference":"3.2.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-4.0.0-20813df3d712928b207378691a45066fae72dd57/node_modules/kind-of/", {"name":"kind-of","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-5.1.0-729c91e2d857b7a419a1f9aa65685c4c33f5845d/node_modules/kind-of/", {"name":"kind-of","reference":"5.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-kind-of-6.0.2-01146b36a6218e64e58f3a8d66de5d7fc6f6d051/node_modules/kind-of/", {"name":"kind-of","reference":"6.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-buffer-1.1.6-efaa2ea9daa0d7ab2ea13a97b2b8ad51fefbe8be/node_modules/is-buffer/", {"name":"is-buffer","reference":"1.1.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-repeat-string-1.6.1-8dcae470e1c88abc2d600fff4a776286da75e637/node_modules/repeat-string/", {"name":"repeat-string","reference":"1.6.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-regex-range-2.1.1-7c80c17b9dfebe599e27367e0d4dd5590141db38/node_modules/to-regex-range/", {"name":"to-regex-range","reference":"2.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isobject-3.0.1-4e431e92b11a9731636aa1f9c8d1ccbcfdab78df/node_modules/isobject/", {"name":"isobject","reference":"3.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isobject-2.1.0-f065561096a3f1da2ef46272f815c840d87e0c89/node_modules/isobject/", {"name":"isobject","reference":"2.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-repeat-element-1.1.3-782e0d825c0c5a3bb39731f84efee6b742e6b1ce/node_modules/repeat-element/", {"name":"repeat-element","reference":"1.1.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-snapdragon-0.8.2-64922e7c565b0e14204ba1aa7d6964278d25182d/node_modules/snapdragon/", {"name":"snapdragon","reference":"0.8.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-base-0.11.2-7bde5ced145b6d551a90db87f83c558b4eb48a8f/node_modules/base/", {"name":"base","reference":"0.11.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cache-base-1.0.1-0a7f46416831c8b662ee36fe4e7c59d76f666ab2/node_modules/cache-base/", {"name":"cache-base","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-collection-visit-1.0.0-4bc0373c164bc3291b4d368c829cf1a80a59dca0/node_modules/collection-visit/", {"name":"collection-visit","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-map-visit-1.0.0-ecdca8f13144e660f1b5bd41f12f3479d98dfb8f/node_modules/map-visit/", {"name":"map-visit","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-visit-1.0.1-f79c4493af0c5377b59fe39d395e41042dd045bb/node_modules/object-visit/", {"name":"object-visit","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-component-emitter-1.2.1-137918d6d78283f7df7a6b7c5a63e140e69425e6/node_modules/component-emitter/", {"name":"component-emitter","reference":"1.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-get-value-2.0.6-dc15ca1c672387ca76bd37ac0a395ba2042a2c28/node_modules/get-value/", {"name":"get-value","reference":"2.0.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-value-1.0.0-18b281da585b1c5c51def24c930ed29a0be6b177/node_modules/has-value/", {"name":"has-value","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-value-0.3.1-7b1f58bada62ca827ec0a2078025654845995e1f/node_modules/has-value/", {"name":"has-value","reference":"0.3.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-values-1.0.0-95b0b63fec2146619a6fe57fe75628d5a39efe4f/node_modules/has-values/", {"name":"has-values","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-values-0.1.4-6d61de95d91dfca9b9a02089ad384bff8f62b771/node_modules/has-values/", {"name":"has-values","reference":"0.1.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-set-value-2.0.0-71ae4a88f0feefbbf52d1ea604f3fb315ebb6274/node_modules/set-value/", {"name":"set-value","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-set-value-0.4.3-7db08f9d3d22dc7f78e53af3c3bf4666ecdfccf1/node_modules/set-value/", {"name":"set-value","reference":"0.4.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-plain-object-2.0.4-2c163b3fafb1b606d9d17928f05c2a1c38e07677/node_modules/is-plain-object/", {"name":"is-plain-object","reference":"2.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-split-string-3.1.0-7cb09dda3a86585705c64b39a6466038682e8fe2/node_modules/split-string/", {"name":"split-string","reference":"3.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-assign-symbols-1.0.0-59667f41fadd4f20ccbc2bb96b8d4f7f78ec0367/node_modules/assign-symbols/", {"name":"assign-symbols","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-object-path-0.3.0-297588b7b0e7e0ac08e04e672f85c1f4999e17af/node_modules/to-object-path/", {"name":"to-object-path","reference":"0.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-union-value-1.0.0-5c71c34cb5bad5dcebe3ea0cd08207ba5aa1aea4/node_modules/union-value/", {"name":"union-value","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-arr-union-3.1.0-e39b09aea9def866a8f206e288af63919bae39c4/node_modules/arr-union/", {"name":"arr-union","reference":"3.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-unset-value-1.0.0-8376873f7d2335179ffb1e6fc3a8ed0dfc8ab559/node_modules/unset-value/", {"name":"unset-value","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-class-utils-0.3.6-f93369ae8b9a7ce02fd41faad0ca83033190c463/node_modules/class-utils/", {"name":"class-utils","reference":"0.3.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-define-property-0.2.5-c35b1ef918ec3c990f9a5bc57be04aacec5c8116/node_modules/define-property/", {"name":"define-property","reference":"0.2.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-define-property-1.0.0-769ebaaf3f4a63aad3af9e8d304c9bbe79bfb0e6/node_modules/define-property/", {"name":"define-property","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-define-property-2.0.2-d459689e8d654ba77e02a817f8710d702cb16e9d/node_modules/define-property/", {"name":"define-property","reference":"2.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-descriptor-0.1.6-366d8240dde487ca51823b1ab9f07a10a78251ca/node_modules/is-descriptor/", {"name":"is-descriptor","reference":"0.1.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-descriptor-1.0.2-3b159746a66604b04f8c81524ba365c5f14d86ec/node_modules/is-descriptor/", {"name":"is-descriptor","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-accessor-descriptor-0.1.6-a9e12cb3ae8d876727eeef3843f8a0897b5c98d6/node_modules/is-accessor-descriptor/", {"name":"is-accessor-descriptor","reference":"0.1.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-accessor-descriptor-1.0.0-169c2f6d3df1f992618072365c9b0ea1f6878656/node_modules/is-accessor-descriptor/", {"name":"is-accessor-descriptor","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-data-descriptor-0.1.4-0b5ee648388e2c860282e793f1856fec3f301b56/node_modules/is-data-descriptor/", {"name":"is-data-descriptor","reference":"0.1.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-data-descriptor-1.0.0-d84876321d0e7add03990406abbbbd36ba9268c7/node_modules/is-data-descriptor/", {"name":"is-data-descriptor","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-static-extend-0.1.2-60809c39cbff55337226fd5e0b520f341f1fb5c6/node_modules/static-extend/", {"name":"static-extend","reference":"0.1.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-copy-0.1.0-7e7d858b781bd7c991a41ba975ed3812754e998c/node_modules/object-copy/", {"name":"object-copy","reference":"0.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-copy-descriptor-0.1.1-676f6eb3c39997c2ee1ac3a924fd6124748f578d/node_modules/copy-descriptor/", {"name":"copy-descriptor","reference":"0.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mixin-deep-1.3.1-a49e7268dce1a0d9698e45326c5626df3543d0fe/node_modules/mixin-deep/", {"name":"mixin-deep","reference":"1.3.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-for-in-1.0.2-81068d295a8142ec0ac726c6e2200c30fb6d5e80/node_modules/for-in/", {"name":"for-in","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pascalcase-0.1.1-b363e55e8006ca6fe21784d2db22bd15d7917f14/node_modules/pascalcase/", {"name":"pascalcase","reference":"0.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-debug-2.6.9-5d128515df134ff327e90a4c93f4e077a536341f/node_modules/debug/", {"name":"debug","reference":"2.6.9"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ms-2.0.0-5608aeadfc00be6c2901df5f9861788de0d597c8/node_modules/ms/", {"name":"ms","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-map-cache-0.2.2-c32abd0bd6525d9b051645bb4f26ac5dc98a0dbf/node_modules/map-cache/", {"name":"map-cache","reference":"0.2.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-0.5.7-8a039d2d1021d22d1ea14c80d8ea468ba2ef3fcc/node_modules/source-map/", {"name":"source-map","reference":"0.5.7"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-0.6.1-74722af32e9614e9c287a8d0bbde48b5e2f1a263/node_modules/source-map/", {"name":"source-map","reference":"0.6.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-resolve-0.5.2-72e2cc34095543e43b2c62b2c4c10d4a9054f259/node_modules/source-map-resolve/", {"name":"source-map-resolve","reference":"0.5.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-atob-2.1.2-6d9517eb9e030d2436666651e86bd9f6f13533c9/node_modules/atob/", {"name":"atob","reference":"2.1.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-decode-uri-component-0.2.0-eb3913333458775cb84cd1a1fae062106bb87545/node_modules/decode-uri-component/", {"name":"decode-uri-component","reference":"0.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-resolve-url-0.2.1-2c637fe77c893afd2a663fe21aa9080068e2052a/node_modules/resolve-url/", {"name":"resolve-url","reference":"0.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-map-url-0.4.0-3e935d7ddd73631b97659956d55128e87b5084a3/node_modules/source-map-url/", {"name":"source-map-url","reference":"0.4.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-urix-0.1.0-da937f7a62e21fec1fd18d49b35c2935067a6c72/node_modules/urix/", {"name":"urix","reference":"0.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-use-3.1.1-d50c8cac79a19fbc20f2911f56eb973f4e10070f/node_modules/use/", {"name":"use","reference":"3.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-snapdragon-node-2.1.1-6c175f86ff14bdb0724563e8f3c1b021a286853b/node_modules/snapdragon-node/", {"name":"snapdragon-node","reference":"2.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-snapdragon-util-3.0.1-f956479486f2acd79700693f6f7b805e45ab56e2/node_modules/snapdragon-util/", {"name":"snapdragon-util","reference":"3.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-regex-3.0.2-13cfdd9b336552f30b51f33a8ae1b42a7a7599ce/node_modules/to-regex/", {"name":"to-regex","reference":"3.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-regex-not-1.0.2-1f4ece27e00b0b65e0247a6810e6a85d83a5752c/node_modules/regex-not/", {"name":"regex-not","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-safe-regex-1.1.0-40a3669f3b077d1e943d44629e157dd48023bf2e/node_modules/safe-regex/", {"name":"safe-regex","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ret-0.1.15-b8a4825d5bdb1fc3f6f53c2bc33f81388681c7bc/node_modules/ret/", {"name":"ret","reference":"0.1.15"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-extglob-2.0.4-ad00fe4dc612a9232e8718711dc5cb5ab0285543/node_modules/extglob/", {"name":"extglob","reference":"2.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-expand-brackets-2.1.4-b77735e315ce30f6b6eff0f83b04151a22449622/node_modules/expand-brackets/", {"name":"expand-brackets","reference":"2.1.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-posix-character-classes-0.1.1-01eac0fe3b5af71a2a6c02feabb8c1fef7e00eab/node_modules/posix-character-classes/", {"name":"posix-character-classes","reference":"0.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fragment-cache-0.2.1-4290fad27f13e89be7f33799c6bc5a0abfff0d19/node_modules/fragment-cache/", {"name":"fragment-cache","reference":"0.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-nanomatch-1.2.13-b87a8aa4fc0de8fe6be88895b38983ff265bd119/node_modules/nanomatch/", {"name":"nanomatch","reference":"1.2.13"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-windows-1.0.2-d1850eb9791ecd18e6182ce12a30f396634bb19d/node_modules/is-windows/", {"name":"is-windows","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-object-pick-1.3.0-87a10ac4c1694bd2e1cbf53591a66141fb5dd747/node_modules/object.pick/", {"name":"object.pick","reference":"1.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mkdirp-0.5.1-30057438eac6cf7f8c4767f38648d6697d75c903/node_modules/mkdirp/", {"name":"mkdirp","reference":"0.5.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimist-0.0.8-857fcabfc3397d2625b8228262e86aa7a011b05d/node_modules/minimist/", {"name":"minimist","reference":"0.0.8"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-neo-async-2.6.0-b9d15e4d71c6762908654b5183ed38b753340835/node_modules/neo-async/", {"name":"neo-async","reference":"2.6.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-node-libs-browser-2.1.0-5f94263d404f6e44767d726901fff05478d600df/node_modules/node-libs-browser/", {"name":"node-libs-browser","reference":"2.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-assert-1.4.1-99912d591836b5a6f5b345c0f07eefc08fc65d91/node_modules/assert/", {"name":"assert","reference":"1.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-util-0.10.3-7afb1afe50805246489e3db7fe0ed379336ac0f9/node_modules/util/", {"name":"util","reference":"0.10.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-util-0.10.4-3aa0125bfe668a4672de58857d3ace27ecb76901/node_modules/util/", {"name":"util","reference":"0.10.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-zlib-0.2.0-2869459d9aa3be245fe8fe2ca1f46e2e7f54d73f/node_modules/browserify-zlib/", {"name":"browserify-zlib","reference":"0.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pako-1.0.6-0101211baa70c4bca4a0f63f2206e97b7dfaf258/node_modules/pako/", {"name":"pako","reference":"1.0.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-buffer-4.9.1-6d1bb601b07a4efced97094132093027c95bc298/node_modules/buffer/", {"name":"buffer","reference":"4.9.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-base64-js-1.3.0-cab1e6118f051095e58b5281aea8c1cd22bfc0e3/node_modules/base64-js/", {"name":"base64-js","reference":"1.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ieee754-1.1.12-50bf24e5b9c8bb98af4964c941cdb0918da7b60b/node_modules/ieee754/", {"name":"ieee754","reference":"1.1.12"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-console-browserify-1.1.0-f0241c45730a9fc6323b206dbf38edc741d0bb10/node_modules/console-browserify/", {"name":"console-browserify","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-date-now-0.1.4-eaf439fd4d4848ad74e5cc7dbef200672b9e345b/node_modules/date-now/", {"name":"date-now","reference":"0.1.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-constants-browserify-1.0.0-c20b96d8c617748aaf1c16021760cd27fcb8cb75/node_modules/constants-browserify/", {"name":"constants-browserify","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-crypto-browserify-3.12.0-396cf9f3137f03e4b8e532c58f698254e00f80ec/node_modules/crypto-browserify/", {"name":"crypto-browserify","reference":"3.12.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-cipher-1.0.1-8d6474c1b870bfdabcd3bcfcc1934a10e94f15f0/node_modules/browserify-cipher/", {"name":"browserify-cipher","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-aes-1.2.0-326734642f403dabc3003209853bb70ad428ef48/node_modules/browserify-aes/", {"name":"browserify-aes","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-buffer-xor-1.0.3-26e61ed1422fb70dd42e6e36729ed51d855fe8d9/node_modules/buffer-xor/", {"name":"buffer-xor","reference":"1.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cipher-base-1.0.4-8760e4ecc272f4c363532f926d874aae2c1397de/node_modules/cipher-base/", {"name":"cipher-base","reference":"1.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-create-hash-1.2.0-889078af11a63756bcfb59bd221996be3a9ef196/node_modules/create-hash/", {"name":"create-hash","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-md5-js-1.3.5-b5d07b8e3216e3e27cd728d72f70d1e6a342005f/node_modules/md5.js/", {"name":"md5.js","reference":"1.3.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hash-base-3.0.4-5fc8686847ecd73499403319a6b0a3f3f6ae4918/node_modules/hash-base/", {"name":"hash-base","reference":"3.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ripemd160-2.0.2-a1c1a6f624751577ba5d07914cbc92850585890c/node_modules/ripemd160/", {"name":"ripemd160","reference":"2.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-sha-js-2.4.11-37a5cf0b81ecbc6943de109ba2960d1b26584ae7/node_modules/sha.js/", {"name":"sha.js","reference":"2.4.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-evp-bytestokey-1.0.3-7fcbdb198dc71959432efe13842684e0525acb02/node_modules/evp_bytestokey/", {"name":"evp_bytestokey","reference":"1.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-des-1.0.2-3af4f1f59839403572f1c66204375f7a7f703e9c/node_modules/browserify-des/", {"name":"browserify-des","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-des-js-1.0.0-c074d2e2aa6a8a9a07dbd61f9a15c2cd83ec8ecc/node_modules/des.js/", {"name":"des.js","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimalistic-assert-1.0.1-2e194de044626d4a10e7f7fbc00ce73e83e4d5c7/node_modules/minimalistic-assert/", {"name":"minimalistic-assert","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-sign-4.0.4-aa4eb68e5d7b658baa6bf6a57e630cbd7a93d298/node_modules/browserify-sign/", {"name":"browserify-sign","reference":"4.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-bn-js-4.11.8-2cde09eb5ee341f484746bb0309b3253b1b1442f/node_modules/bn.js/", {"name":"bn.js","reference":"4.11.8"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-browserify-rsa-4.0.1-21e0abfaf6f2029cf2fafb133567a701d4135524/node_modules/browserify-rsa/", {"name":"browserify-rsa","reference":"4.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-randombytes-2.0.6-d302c522948588848a8d300c932b44c24231da80/node_modules/randombytes/", {"name":"randombytes","reference":"2.0.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-create-hmac-1.1.7-69170c78b3ab957147b2b8b04572e47ead2243ff/node_modules/create-hmac/", {"name":"create-hmac","reference":"1.1.7"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-elliptic-6.4.1-c2d0b7776911b86722c632c3c06c60f2f819939a/node_modules/elliptic/", {"name":"elliptic","reference":"6.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-brorand-1.1.0-12c25efe40a45e3c323eb8675a0a0ce57b22371f/node_modules/brorand/", {"name":"brorand","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hash-js-1.1.5-e38ab4b85dfb1e0c40fe9265c0e9b54854c23812/node_modules/hash.js/", {"name":"hash.js","reference":"1.1.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hmac-drbg-1.0.1-d2745701025a6c775a6c545793ed502fc0c649a1/node_modules/hmac-drbg/", {"name":"hmac-drbg","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimalistic-crypto-utils-1.0.1-f6c00c1c0b082246e5c4d99dfb8c7c083b2b582a/node_modules/minimalistic-crypto-utils/", {"name":"minimalistic-crypto-utils","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-parse-asn1-5.1.1-f6bf293818332bd0dab54efb16087724745e6ca8/node_modules/parse-asn1/", {"name":"parse-asn1","reference":"5.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-asn1-js-4.10.1-b9c2bf5805f1e64aadeed6df3a2bfafb5a73f5a0/node_modules/asn1.js/", {"name":"asn1.js","reference":"4.10.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pbkdf2-3.0.17-976c206530617b14ebb32114239f7b09336e93a6/node_modules/pbkdf2/", {"name":"pbkdf2","reference":"3.0.17"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-create-ecdh-4.0.3-c9111b6f33045c4697f144787f9254cdc77c45ff/node_modules/create-ecdh/", {"name":"create-ecdh","reference":"4.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-diffie-hellman-5.0.3-40e8ee98f55a2149607146921c63e1ae5f3d2875/node_modules/diffie-hellman/", {"name":"diffie-hellman","reference":"5.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-miller-rabin-4.0.1-f080351c865b0dc562a8462966daa53543c78a4d/node_modules/miller-rabin/", {"name":"miller-rabin","reference":"4.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-public-encrypt-4.0.3-4fcc9d77a07e48ba7527e7cbe0de33d0701331e0/node_modules/public-encrypt/", {"name":"public-encrypt","reference":"4.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-randomfill-1.0.4-c92196fc86ab42be983f1bf31778224931d61458/node_modules/randomfill/", {"name":"randomfill","reference":"1.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-domain-browser-1.2.0-3d31f50191a6749dd1375a7f522e823d42e54eda/node_modules/domain-browser/", {"name":"domain-browser","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-events-1.1.1-9ebdb7635ad099c70dcc4c2a1f5004288e8bd924/node_modules/events/", {"name":"events","reference":"1.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-https-browserify-1.0.0-ec06c10e0a34c0f2faf199f7fd7fc78fffd03c73/node_modules/https-browserify/", {"name":"https-browserify","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-os-browserify-0.3.0-854373c7f5c2315914fc9bfc6bd8238fdda1ec27/node_modules/os-browserify/", {"name":"os-browserify","reference":"0.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-browserify-0.0.0-a0b870729aae214005b7d5032ec2cbbb0fb4451a/node_modules/path-browserify/", {"name":"path-browserify","reference":"0.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-process-0.11.10-7332300e840161bda3e69a1d1d91a7d4bc16f182/node_modules/process/", {"name":"process","reference":"0.11.10"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-querystring-es3-0.2.1-9ec61f79049875707d69414596fd907a4d711e73/node_modules/querystring-es3/", {"name":"querystring-es3","reference":"0.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-browserify-2.0.1-66266ee5f9bdb9940a4e4514cafb43bb71e5c9db/node_modules/stream-browserify/", {"name":"stream-browserify","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-http-2.8.3-b2d242469288a5a27ec4fe8933acf623de6514fc/node_modules/stream-http/", {"name":"stream-http","reference":"2.8.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-builtin-status-codes-3.0.0-85982878e21b98e1c66425e03d0174788f569ee8/node_modules/builtin-status-codes/", {"name":"builtin-status-codes","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-to-arraybuffer-1.0.1-7d229b1fcc637e466ca081180836a7aabff83f43/node_modules/to-arraybuffer/", {"name":"to-arraybuffer","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-xtend-4.0.1-a5c6d532be656e23db820efb943a1f04998d63af/node_modules/xtend/", {"name":"xtend","reference":"4.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-timers-browserify-2.0.10-1d28e3d2aadf1d5a5996c4e9f95601cd053480ae/node_modules/timers-browserify/", {"name":"timers-browserify","reference":"2.0.10"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-setimmediate-1.0.5-290cbb232e306942d7d7ea9b83732ab7856f8285/node_modules/setimmediate/", {"name":"setimmediate","reference":"1.0.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tty-browserify-0.0.0-a157ba402da24e9bf957f9aa69d524eed42901a6/node_modules/tty-browserify/", {"name":"tty-browserify","reference":"0.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-url-0.11.0-3838e97cfc60521eb73c525a8e55bfdd9e2e28f1/node_modules/url/", {"name":"url","reference":"0.11.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-querystring-0.2.0-b209849203bb25df820da756e747005878521620/node_modules/querystring/", {"name":"querystring","reference":"0.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-vm-browserify-0.0.4-5d7ea45bbef9e4a6ff65f95438e0a87c357d5a73/node_modules/vm-browserify/", {"name":"vm-browserify","reference":"0.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-indexof-0.0.1-82dc336d232b9062179d05ab3293a66059fd435d/node_modules/indexof/", {"name":"indexof","reference":"0.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-schema-utils-0.4.7-ba74f597d2be2ea880131746ee17d0a093c68187/node_modules/schema-utils/", {"name":"schema-utils","reference":"0.4.7"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-uglifyjs-webpack-plugin-1.3.0-75f548160858163a08643e086d5fefe18a5d67de/node_modules/uglifyjs-webpack-plugin/", {"name":"uglifyjs-webpack-plugin","reference":"1.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cacache-10.0.4-6452367999eff9d4188aefd9a14e9d7c6a263460/node_modules/cacache/", {"name":"cacache","reference":"10.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-bluebird-3.5.3-7d01c6f9616c9a51ab0f8c549a79dfe6ec33efa7/node_modules/bluebird/", {"name":"bluebird","reference":"3.5.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chownr-1.1.1-54726b8b8fff4df053c42187e801fb4412df1494/node_modules/chownr/", {"name":"chownr","reference":"1.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-glob-7.1.3-3960832d3f1574108342dafd3a67b332c0969df1/node_modules/glob/", {"name":"glob","reference":"7.1.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fs-realpath-1.0.0-1504ad2523158caa40db4a2787cb01411994ea4f/node_modules/fs.realpath/", {"name":"fs.realpath","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inflight-1.0.6-49bd6331d7d02d0c09bc910a1075ba8165b56df9/node_modules/inflight/", {"name":"inflight","reference":"1.0.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-once-1.4.0-583b1aa775961d4b113ac17d9c50baef9dd76bd1/node_modules/once/", {"name":"once","reference":"1.4.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-wrappy-1.0.2-b5243d8f3ec1aa35f1364605bc0d1036e30ab69f/node_modules/wrappy/", {"name":"wrappy","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-minimatch-3.0.4-5166e286457f03306064be5497e8dbb0c3d32083/node_modules/minimatch/", {"name":"minimatch","reference":"3.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-brace-expansion-1.1.11-3c7fcbf529d87226f3d2f52b966ff5271eb441dd/node_modules/brace-expansion/", {"name":"brace-expansion","reference":"1.1.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-balanced-match-1.0.0-89b4d199ab2bee49de164ea02b89ce462d71b767/node_modules/balanced-match/", {"name":"balanced-match","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-concat-map-0.0.1-d8a96bd77fd68df7793a73036a3ba0d5405d477b/node_modules/concat-map/", {"name":"concat-map","reference":"0.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-is-absolute-1.0.1-174b9268735534ffbc7ace6bf53a5a9e1b5c5f5f/node_modules/path-is-absolute/", {"name":"path-is-absolute","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-lru-cache-4.1.3-a1175cf3496dfc8436c156c334b4955992bce69c/node_modules/lru-cache/", {"name":"lru-cache","reference":"4.1.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pseudomap-1.0.2-f052a28da70e618917ef0a8ac34c1ae5a68286b3/node_modules/pseudomap/", {"name":"pseudomap","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-yallist-2.1.2-1c11f9218f076089a47dd512f93c6699a6a81d52/node_modules/yallist/", {"name":"yallist","reference":"2.1.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mississippi-2.0.0-3442a508fafc28500486feea99409676e4ee5a6f/node_modules/mississippi/", {"name":"mississippi","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-concat-stream-1.6.2-904bdf194cd3122fc675c77fc4ac3d4ff0fd1a34/node_modules/concat-stream/", {"name":"concat-stream","reference":"1.6.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-buffer-from-1.1.1-32713bc028f75c02fdb710d7c7bcec1f2c6070ef/node_modules/buffer-from/", {"name":"buffer-from","reference":"1.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-typedarray-0.0.6-867ac74e3864187b1d3d47d996a78ec5c8830777/node_modules/typedarray/", {"name":"typedarray","reference":"0.0.6"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-duplexify-3.6.1-b1a7a29c4abfd639585efaecce80d666b1e34125/node_modules/duplexify/", {"name":"duplexify","reference":"3.6.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-end-of-stream-1.4.1-ed29634d19baba463b6ce6b80a37213eab71ec43/node_modules/end-of-stream/", {"name":"end-of-stream","reference":"1.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-shift-1.0.0-d5c752825e5367e786f78e18e445ea223a155952/node_modules/stream-shift/", {"name":"stream-shift","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-flush-write-stream-1.0.3-c5d586ef38af6097650b49bc41b55fabb19f35bd/node_modules/flush-write-stream/", {"name":"flush-write-stream","reference":"1.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-from2-2.3.0-8bfb5502bde4a4d36cfdeea007fcca21d7e382af/node_modules/from2/", {"name":"from2","reference":"2.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-parallel-transform-1.1.0-d410f065b05da23081fcd10f28854c29bda33b06/node_modules/parallel-transform/", {"name":"parallel-transform","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cyclist-0.2.2-1b33792e11e914a2fd6d6ed6447464444e5fa640/node_modules/cyclist/", {"name":"cyclist","reference":"0.2.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pump-2.0.1-12399add6e4cf7526d973cbc8b5ce2e2908b3909/node_modules/pump/", {"name":"pump","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pumpify-1.5.1-36513be246ab27570b1a374a5ce278bfd74370ce/node_modules/pumpify/", {"name":"pumpify","reference":"1.5.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-stream-each-1.2.3-ebe27a0c389b04fbcc233642952e10731afa9bae/node_modules/stream-each/", {"name":"stream-each","reference":"1.2.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-through2-2.0.5-01c1e39eb31d07cb7d03a96a70823260b23132cd/node_modules/through2/", {"name":"through2","reference":"2.0.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-move-concurrently-1.0.1-be2c005fda32e0b29af1f05d7c4b33214c701f92/node_modules/move-concurrently/", {"name":"move-concurrently","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-aproba-1.2.0-6802e6264efd18c790a1b0d517f0f2627bf2c94a/node_modules/aproba/", {"name":"aproba","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-copy-concurrently-1.0.5-92297398cae34937fcafd6ec8139c18051f0b5e0/node_modules/copy-concurrently/", {"name":"copy-concurrently","reference":"1.0.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fs-write-stream-atomic-1.0.10-b47df53493ef911df75731e70a9ded0189db40c9/node_modules/fs-write-stream-atomic/", {"name":"fs-write-stream-atomic","reference":"1.0.10"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-iferr-0.1.5-c60eed69e6d8fdb6b3104a1fcbca1c192dc5b501/node_modules/iferr/", {"name":"iferr","reference":"0.1.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-imurmurhash-0.1.4-9218b9b2b928a238b13dc4fb6b6d576f231453ea/node_modules/imurmurhash/", {"name":"imurmurhash","reference":"0.1.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-rimraf-2.6.2-2ed8150d24a16ea8651e6d6ef0f47c4158ce7a36/node_modules/rimraf/", {"name":"rimraf","reference":"2.6.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-run-queue-1.0.3-e848396f057d223f24386924618e25694161ec47/node_modules/run-queue/", {"name":"run-queue","reference":"1.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-promise-inflight-1.0.1-98472870bf228132fcbdd868129bad12c3c029e3/node_modules/promise-inflight/", {"name":"promise-inflight","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ssri-5.3.0-ba3872c9c6d33a0704a7d71ff045e5ec48999d06/node_modules/ssri/", {"name":"ssri","reference":"5.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-unique-filename-1.1.1-1d69769369ada0583103a1e6ae87681b56573230/node_modules/unique-filename/", {"name":"unique-filename","reference":"1.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-unique-slug-2.0.1-5e9edc6d1ce8fb264db18a507ef9bd8544451ca6/node_modules/unique-slug/", {"name":"unique-slug","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-y18n-4.0.0-95ef94f85ecc81d007c264e190a120f0a3c8566b/node_modules/y18n/", {"name":"y18n","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-find-cache-dir-1.0.0-9288e3e9e3cc3748717d39eade17cf71fc30ee6f/node_modules/find-cache-dir/", {"name":"find-cache-dir","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-commondir-1.0.1-ddd800da0c66127393cca5950ea968a3aaf1253b/node_modules/commondir/", {"name":"commondir","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-make-dir-1.3.0-79c1033b80515bd6d24ec9933e860ca75ee27f0c/node_modules/make-dir/", {"name":"make-dir","reference":"1.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pify-3.0.0-e5a4acd2c101fdf3d9a4d07f0dbc4db49dd28176/node_modules/pify/", {"name":"pify","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-pkg-dir-2.0.0-f6d5d1109e19d63edf428e0bd57e12777615334b/node_modules/pkg-dir/", {"name":"pkg-dir","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-find-up-2.1.0-45d1b7e506c717ddd482775a2b77920a3c0c57a7/node_modules/find-up/", {"name":"find-up","reference":"2.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-locate-path-2.0.0-2b568b265eec944c6d9c0de9c3dbbbca0354cd8e/node_modules/locate-path/", {"name":"locate-path","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-locate-2.0.0-20a0103b222a70c8fd39cc2e580680f3dde5ec43/node_modules/p-locate/", {"name":"p-locate","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-limit-1.3.0-b86bd5f0c25690911c7590fcbfc2010d54b3ccb8/node_modules/p-limit/", {"name":"p-limit","reference":"1.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-try-1.0.0-cbc79cdbaf8fd4228e13f621f2b1a237c1b207b3/node_modules/p-try/", {"name":"p-try","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-exists-3.0.0-ce0ebeaa5f78cb18925ea7d810d7b59b010fd515/node_modules/path-exists/", {"name":"path-exists","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-serialize-javascript-1.5.0-1aa336162c88a890ddad5384baebc93a655161fe/node_modules/serialize-javascript/", {"name":"serialize-javascript","reference":"1.5.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-uglify-es-3.3.9-0c1c4f0700bed8dbc124cdb304d2592ca203e677/node_modules/uglify-es/", {"name":"uglify-es","reference":"3.3.9"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-commander-2.13.0-6964bca67685df7c1f1430c584f07d7597885b9c/node_modules/commander/", {"name":"commander","reference":"2.13.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-webpack-sources-1.3.0-2a28dcb9f1f45fe960d8f1493252b5ee6530fa85/node_modules/webpack-sources/", {"name":"webpack-sources","reference":"1.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-source-list-map-2.0.1-3993bd873bfc48479cca9ea3a547835c7c154b34/node_modules/source-list-map/", {"name":"source-list-map","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-worker-farm-1.6.0-aecc405976fab5a95526180846f0dba288f3a4a0/node_modules/worker-farm/", {"name":"worker-farm","reference":"1.6.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-watchpack-1.6.0-4bc12c2ebe8aa277a71f1d3f14d685c7b446cd00/node_modules/watchpack/", {"name":"watchpack","reference":"1.6.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chokidar-2.0.4-356ff4e2b0e8e43e322d18a372460bbcf3accd26/node_modules/chokidar/", {"name":"chokidar","reference":"2.0.4"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-anymatch-2.0.0-bcb24b4f37934d9aa7ac17b4adaf89e7c76ef2eb/node_modules/anymatch/", {"name":"anymatch","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-normalize-path-2.1.1-1ab28b556e198363a8c1a6f7e6fa20137fe6aed9/node_modules/normalize-path/", {"name":"normalize-path","reference":"2.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-remove-trailing-separator-1.1.0-c24bce2a283adad5bc3f58e0d48249b92379d8ef/node_modules/remove-trailing-separator/", {"name":"remove-trailing-separator","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-async-each-1.0.1-19d386a1d9edc6e7c1c85d388aedbcc56d33602d/node_modules/async-each/", {"name":"async-each","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-glob-parent-3.1.0-9e6af6299d8d3bd2bd40430832bd113df906c5ae/node_modules/glob-parent/", {"name":"glob-parent","reference":"3.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-glob-3.1.0-7ba5ae24217804ac70707b96922567486cc3e84a/node_modules/is-glob/", {"name":"is-glob","reference":"3.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-glob-4.0.0-9521c76845cc2610a85203ddf080a958c2ffabc0/node_modules/is-glob/", {"name":"is-glob","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-extglob-2.1.1-a88c02535791f02ed37c76a1b9ea9773c833f8c2/node_modules/is-extglob/", {"name":"is-extglob","reference":"2.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-dirname-1.0.2-cc33d24d525e099a5388c0336c6e32b9160609e0/node_modules/path-dirname/", {"name":"path-dirname","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-binary-path-1.0.1-75f16642b480f187a711c814161fd3a4a7655898/node_modules/is-binary-path/", {"name":"is-binary-path","reference":"1.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-binary-extensions-1.12.0-c2d780f53d45bba8317a8902d4ceeaf3a6385b14/node_modules/binary-extensions/", {"name":"binary-extensions","reference":"1.12.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-lodash-debounce-4.0.8-82d79bff30a67c4005ffd5e2515300ad9ca4d7af/node_modules/lodash.debounce/", {"name":"lodash.debounce","reference":"4.0.8"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-readdirp-2.2.1-0e87622a3325aa33e892285caf8b4e846529a525/node_modules/readdirp/", {"name":"readdirp","reference":"2.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-upath-1.1.0-35256597e46a581db4793d0ce47fa9aebfc9fabd/node_modules/upath/", {"name":"upath","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-hygen-1.6.2-280c38805c4afbfc8717dc2657a009529bc10768/node_modules/hygen/", {"name":"hygen","reference":"1.6.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chalk-2.4.1-18c49ab16a037b6eb0152cc83e3471338215b66e/node_modules/chalk/", {"name":"chalk","reference":"2.4.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ansi-styles-3.2.1-41fbb20243e50b12be0f04b8dedbf07520ce841d/node_modules/ansi-styles/", {"name":"ansi-styles","reference":"3.2.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-color-convert-1.9.3-bb71850690e1f136567de629d2d5471deda4c1e8/node_modules/color-convert/", {"name":"color-convert","reference":"1.9.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-color-name-1.1.3-a7d0558bd89c42f795dd42328f740831ca53bc25/node_modules/color-name/", {"name":"color-name","reference":"1.1.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-escape-string-regexp-1.0.5-1b61c0562190a8dff6ae3bb2cf0200ca130b86d4/node_modules/escape-string-regexp/", {"name":"escape-string-regexp","reference":"1.0.5"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-supports-color-5.5.0-e2e69a44ac8772f78a1ec0b35b689df6530efc8f/node_modules/supports-color/", {"name":"supports-color","reference":"5.5.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-has-flag-3.0.0-b5d454dc2199ae225699f3467e5a07f3b955bafd/node_modules/has-flag/", {"name":"has-flag","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ejs-2.6.1-498ec0d495655abc6f23cd61868d926464071aa0/node_modules/ejs/", {"name":"ejs","reference":"2.6.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-execa-0.9.0-adb7ce62cf985071f60580deb4a88b9e34712d01/node_modules/execa/", {"name":"execa","reference":"0.9.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cross-spawn-5.1.0-e8bd0efee58fcff6f8f94510a0a554bbfa235449/node_modules/cross-spawn/", {"name":"cross-spawn","reference":"5.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-shebang-command-1.2.0-44aac65b695b03398968c39f363fee5deafdf1ea/node_modules/shebang-command/", {"name":"shebang-command","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-shebang-regex-1.0.0-da42f49740c0b42db2ca9728571cb190c98efea3/node_modules/shebang-regex/", {"name":"shebang-regex","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-which-1.3.1-a45043d54f5805316da8d62f9f50918d3da70b0a/node_modules/which/", {"name":"which","reference":"1.3.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-isexe-2.0.0-e8fbf374dc556ff8947a10dcb0572d633f2cfa10/node_modules/isexe/", {"name":"isexe","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-get-stream-3.0.0-8e943d1358dc37555054ecbe2edb05aa174ede14/node_modules/get-stream/", {"name":"get-stream","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-stream-1.1.0-12d4a3dd4e68e0b79ceb8dbc84173ae80d91ca44/node_modules/is-stream/", {"name":"is-stream","reference":"1.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-npm-run-path-2.0.2-35a9232dfa35d7067b4cb2ddf2357b1871536c5f/node_modules/npm-run-path/", {"name":"npm-run-path","reference":"2.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-path-key-2.0.1-411cadb574c5a140d3a4b1910d40d80cc9f40b40/node_modules/path-key/", {"name":"path-key","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-p-finally-1.0.0-3fbcfb15b899a44123b34b6dcc18b724336a2cae/node_modules/p-finally/", {"name":"p-finally","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-signal-exit-3.0.2-b5fdc08f1287ea1178628e415e25132b73646c6d/node_modules/signal-exit/", {"name":"signal-exit","reference":"3.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-strip-eof-1.0.0-bb43ff5598a6eb05d89b59fcd129c983313606bf/node_modules/strip-eof/", {"name":"strip-eof","reference":"1.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-front-matter-2.3.0-7203af896ce357ee04e2aa45169ea91ed7f67504/node_modules/front-matter/", {"name":"front-matter","reference":"2.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-js-yaml-3.12.0-eaed656ec8344f10f527c6bfa1b6e2244de167d1/node_modules/js-yaml/", {"name":"js-yaml","reference":"3.12.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-argparse-1.0.10-bcd6791ea5ae09725e17e5ad988134cd40b3d911/node_modules/argparse/", {"name":"argparse","reference":"1.0.10"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-sprintf-js-1.0.3-04e6926f662895354f3dd015203633b857297e2c/node_modules/sprintf-js/", {"name":"sprintf-js","reference":"1.0.3"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-esprima-4.0.1-13b04cdb3e6c5d19df91ab6987a8695619b0aa71/node_modules/esprima/", {"name":"esprima","reference":"4.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-fs-extra-5.0.0-414d0110cdd06705734d055652c5411260c31abd/node_modules/fs-extra/", {"name":"fs-extra","reference":"5.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-jsonfile-4.0.0-8771aae0799b64076b76640fca058f9c10e33ecb/node_modules/jsonfile/", {"name":"jsonfile","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-universalify-0.1.2-b646f69be3942dabcecc9d6639c80dc105efaa66/node_modules/universalify/", {"name":"universalify","reference":"0.1.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inflection-1.12.0-a200935656d6f5f6bc4dc7502e1aecb703228416/node_modules/inflection/", {"name":"inflection","reference":"1.12.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-inquirer-4.0.2-cc678b4cbc0e183a3500cc63395831ec956ab0a3/node_modules/inquirer/", {"name":"inquirer","reference":"4.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ansi-escapes-3.1.0-f73207bb81207d75fd6c83f125af26eea378ca30/node_modules/ansi-escapes/", {"name":"ansi-escapes","reference":"3.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cli-cursor-2.1.0-b35dac376479facc3e94747d41d0d0f5238ffcb5/node_modules/cli-cursor/", {"name":"cli-cursor","reference":"2.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-restore-cursor-2.0.0-9f7ee287f82fd326d4fd162923d62129eee0dfaf/node_modules/restore-cursor/", {"name":"restore-cursor","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-onetime-2.0.1-067428230fd67443b2794b22bba528b6867962d4/node_modules/onetime/", {"name":"onetime","reference":"2.0.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mimic-fn-1.2.0-820c86a39334640e99516928bd03fca88057d022/node_modules/mimic-fn/", {"name":"mimic-fn","reference":"1.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-cli-width-2.2.0-ff19ede8a9a5e579324147b0c11f0fbcbabed639/node_modules/cli-width/", {"name":"cli-width","reference":"2.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-external-editor-2.2.0-045511cfd8d133f3846673d1047c154e214ad3d5/node_modules/external-editor/", {"name":"external-editor","reference":"2.2.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-chardet-0.4.2-b5473b33dc97c424e5d98dc87d55d4d8a29c8bf2/node_modules/chardet/", {"name":"chardet","reference":"0.4.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-iconv-lite-0.4.24-2022b4b25fbddc21d2f524974a474aafe733908b/node_modules/iconv-lite/", {"name":"iconv-lite","reference":"0.4.24"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-safer-buffer-2.1.2-44fa161b0187b9549dd84bb91802f9bd8385cd6a/node_modules/safer-buffer/", {"name":"safer-buffer","reference":"2.1.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-tmp-0.0.33-6d34335889768d21b2bcda0aa277ced3b1bfadf9/node_modules/tmp/", {"name":"tmp","reference":"0.0.33"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-os-tmpdir-1.0.2-bbe67406c79aa85c5cfec766fe5734555dfa1274/node_modules/os-tmpdir/", {"name":"os-tmpdir","reference":"1.0.2"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-figures-2.0.0-3ab1a2d2a62c8bfb431a0c94cb797a2fce27c962/node_modules/figures/", {"name":"figures","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-lodash-4.17.11-b39ea6229ef607ecd89e2c8df12536891cac9b8d/node_modules/lodash/", {"name":"lodash","reference":"4.17.11"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-mute-stream-0.0.7-3075ce93bc21b8fab43e1bc4da7e8115ed1e7bab/node_modules/mute-stream/", {"name":"mute-stream","reference":"0.0.7"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-run-async-2.3.0-0371ab4ae0bdd720d4166d7dfda64ff7a445a6c0/node_modules/run-async/", {"name":"run-async","reference":"2.3.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-promise-2.1.0-79a2a9ece7f096e80f36d2b2f3bc16c1ff4bf3fa/node_modules/is-promise/", {"name":"is-promise","reference":"2.1.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-rx-lite-4.0.8-0b1e11af8bc44836f04a6407e92da42467b79444/node_modules/rx-lite/", {"name":"rx-lite","reference":"4.0.8"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-rx-lite-aggregates-4.0.8-753b87a89a11c95467c4ac1626c4efc4e05c67be/node_modules/rx-lite-aggregates/", {"name":"rx-lite-aggregates","reference":"4.0.8"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-string-width-2.1.1-ab93f27a8dc13d28cac815c462143a6d9012ae9e/node_modules/string-width/", {"name":"string-width","reference":"2.1.1"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-is-fullwidth-code-point-2.0.0-a3b30a5c4f199183167aaab93beefae3ddfb654f/node_modules/is-fullwidth-code-point/", {"name":"is-fullwidth-code-point","reference":"2.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-strip-ansi-4.0.0-a8479022eb1ac368a871389b635262c505ee368f/node_modules/strip-ansi/", {"name":"strip-ansi","reference":"4.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-ansi-regex-3.0.0-ed0317c322064f79466c02966bddb605ab37d998/node_modules/ansi-regex/", {"name":"ansi-regex","reference":"3.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-through-2.3.8-0dd4c9ffaabc357960b1b724115d7e0e86a2e1f5/node_modules/through/", {"name":"through","reference":"2.3.8"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-yargs-parser-7.0.0-8d0ac42f16ea55debd332caf4c4038b3e3f5dfd9/node_modules/yargs-parser/", {"name":"yargs-parser","reference":"7.0.0"}],
  ["../../../Users/victormesquita/AppData/Local/Yarn/Cache/v3/npm-camelcase-4.1.0-d545635be1e33c542649c69173e5de6acfae34dd/node_modules/camelcase/", {"name":"camelcase","reference":"4.1.0"}],
  ["./", topLevelLocator],
]);
exports.findPackageLocator = function findPackageLocator(location) {
  let relativeLocation = normalizePath(path.relative(__dirname, location));

  if (!relativeLocation.match(isStrictRegExp))
    relativeLocation = `./${relativeLocation}`;

  if (location.match(isDirRegExp) && relativeLocation.charAt(relativeLocation.length - 1) !== '/')
    relativeLocation = `${relativeLocation}/`;

  let match;

  if (relativeLocation.length >= 205 && relativeLocation[204] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 205)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 197 && relativeLocation[196] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 197)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 195 && relativeLocation[194] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 195)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 193 && relativeLocation[192] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 193)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 189 && relativeLocation[188] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 189)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 187 && relativeLocation[186] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 187)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 181 && relativeLocation[180] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 181)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 179 && relativeLocation[178] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 179)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 177 && relativeLocation[176] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 177)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 176 && relativeLocation[175] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 176)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 175 && relativeLocation[174] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 175)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 174 && relativeLocation[173] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 174)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 173 && relativeLocation[172] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 173)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 172 && relativeLocation[171] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 172)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 171 && relativeLocation[170] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 171)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 170 && relativeLocation[169] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 170)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 169 && relativeLocation[168] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 169)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 168 && relativeLocation[167] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 168)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 167 && relativeLocation[166] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 167)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 164 && relativeLocation[163] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 164)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 163 && relativeLocation[162] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 163)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 162 && relativeLocation[161] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 162)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 161 && relativeLocation[160] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 161)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 160 && relativeLocation[159] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 160)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 159 && relativeLocation[158] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 159)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 158 && relativeLocation[157] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 158)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 156 && relativeLocation[155] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 156)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 155 && relativeLocation[154] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 155)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 154 && relativeLocation[153] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 154)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 152 && relativeLocation[151] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 152)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 150 && relativeLocation[149] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 150)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 148 && relativeLocation[147] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 148)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 147 && relativeLocation[146] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 147)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 146 && relativeLocation[145] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 146)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 145 && relativeLocation[144] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 145)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 144 && relativeLocation[143] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 144)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 143 && relativeLocation[142] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 143)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 142 && relativeLocation[141] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 142)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 141 && relativeLocation[140] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 141)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 140 && relativeLocation[139] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 140)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 139 && relativeLocation[138] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 139)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 138 && relativeLocation[137] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 138)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 137 && relativeLocation[136] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 137)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 136 && relativeLocation[135] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 136)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 135 && relativeLocation[134] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 135)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 134 && relativeLocation[133] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 134)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 133 && relativeLocation[132] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 133)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 132 && relativeLocation[131] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 132)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 131 && relativeLocation[130] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 131)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 130 && relativeLocation[129] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 130)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 128 && relativeLocation[127] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 128)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 88 && relativeLocation[87] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 88)))
      return blacklistCheck(match);

  if (relativeLocation.length >= 2 && relativeLocation[1] === '/')
    if (match = locatorsByLocations.get(relativeLocation.substr(0, 2)))
      return blacklistCheck(match);

  return null;
};


/**
 * Returns the module that should be used to resolve require calls. It's usually the direct parent, except if we're
 * inside an eval expression.
 */

function getIssuerModule(parent) {
  let issuer = parent;

  while (issuer && (issuer.id === '[eval]' || issuer.id === '<repl>' || !issuer.filename)) {
    issuer = issuer.parent;
  }

  return issuer;
}

/**
 * Returns information about a package in a safe way (will throw if they cannot be retrieved)
 */

function getPackageInformationSafe(packageLocator) {
  const packageInformation = exports.getPackageInformation(packageLocator);

  if (!packageInformation) {
    throw makeError(
      `INTERNAL`,
      `Couldn't find a matching entry in the dependency tree for the specified parent (this is probably an internal error)`,
    );
  }

  return packageInformation;
}

/**
 * Implements the node resolution for folder access and extension selection
 */

function applyNodeExtensionResolution(unqualifiedPath, {extensions}) {
  // We use this "infinite while" so that we can restart the process as long as we hit package folders
  while (true) {
    let stat;

    try {
      stat = statSync(unqualifiedPath);
    } catch (error) {}

    // If the file exists and is a file, we can stop right there

    if (stat && !stat.isDirectory()) {
      // If the very last component of the resolved path is a symlink to a file, we then resolve it to a file. We only
      // do this first the last component, and not the rest of the path! This allows us to support the case of bin
      // symlinks, where a symlink in "/xyz/pkg-name/.bin/bin-name" will point somewhere else (like "/xyz/pkg-name/index.js").
      // In such a case, we want relative requires to be resolved relative to "/xyz/pkg-name/" rather than "/xyz/pkg-name/.bin/".
      //
      // Also note that the reason we must use readlink on the last component (instead of realpath on the whole path)
      // is that we must preserve the other symlinks, in particular those used by pnp to deambiguate packages using
      // peer dependencies. For example, "/xyz/.pnp/local/pnp-01234569/.bin/bin-name" should see its relative requires
      // be resolved relative to "/xyz/.pnp/local/pnp-0123456789/" rather than "/xyz/pkg-with-peers/", because otherwise
      // we would lose the information that would tell us what are the dependencies of pkg-with-peers relative to its
      // ancestors.

      if (lstatSync(unqualifiedPath).isSymbolicLink()) {
        unqualifiedPath = path.normalize(path.resolve(path.dirname(unqualifiedPath), readlinkSync(unqualifiedPath)));
      }

      return unqualifiedPath;
    }

    // If the file is a directory, we must check if it contains a package.json with a "main" entry

    if (stat && stat.isDirectory()) {
      let pkgJson;

      try {
        pkgJson = JSON.parse(readFileSync(`${unqualifiedPath}/package.json`, 'utf-8'));
      } catch (error) {}

      let nextUnqualifiedPath;

      if (pkgJson && pkgJson.main) {
        nextUnqualifiedPath = path.resolve(unqualifiedPath, pkgJson.main);
      }

      // If the "main" field changed the path, we start again from this new location

      if (nextUnqualifiedPath && nextUnqualifiedPath !== unqualifiedPath) {
        unqualifiedPath = nextUnqualifiedPath;
        continue;
      }
    }

    // Otherwise we check if we find a file that match one of the supported extensions

    const qualifiedPath = extensions
      .map(extension => {
        return `${unqualifiedPath}${extension}`;
      })
      .find(candidateFile => {
        return existsSync(candidateFile);
      });

    if (qualifiedPath) {
      return qualifiedPath;
    }

    // Otherwise, we check if the path is a folder - in such a case, we try to use its index

    if (stat && stat.isDirectory()) {
      const indexPath = extensions
        .map(extension => {
          return `${unqualifiedPath}/index${extension}`;
        })
        .find(candidateFile => {
          return existsSync(candidateFile);
        });

      if (indexPath) {
        return indexPath;
      }
    }

    // Otherwise there's nothing else we can do :(

    return null;
  }
}

/**
 * This function creates fake modules that can be used with the _resolveFilename function.
 * Ideally it would be nice to be able to avoid this, since it causes useless allocations
 * and cannot be cached efficiently (we recompute the nodeModulePaths every time).
 *
 * Fortunately, this should only affect the fallback, and there hopefully shouldn't be a
 * lot of them.
 */

function makeFakeModule(path) {
  const fakeModule = new Module(path, false);
  fakeModule.filename = path;
  fakeModule.paths = Module._nodeModulePaths(path);
  return fakeModule;
}

/**
 * Normalize path to posix format.
 */

// eslint-disable-next-line no-unused-vars
function normalizePath(fsPath) {
  return process.platform === 'win32' ? fsPath.replace(backwardSlashRegExp, '/') : fsPath;
}

/**
 * Forward the resolution to the next resolver (usually the native one)
 */

function callNativeResolution(request, issuer) {
  if (issuer.endsWith('/')) {
    issuer += 'internal.js';
  }

  try {
    enableNativeHooks = false;

    // Since we would need to create a fake module anyway (to call _resolveLookupPath that
    // would give us the paths to give to _resolveFilename), we can as well not use
    // the {paths} option at all, since it internally makes _resolveFilename create another
    // fake module anyway.
    return Module._resolveFilename(request, makeFakeModule(issuer), false);
  } finally {
    enableNativeHooks = true;
  }
}

/**
 * This key indicates which version of the standard is implemented by this resolver. The `std` key is the
 * Plug'n'Play standard, and any other key are third-party extensions. Third-party extensions are not allowed
 * to override the standard, and can only offer new methods.
 *
 * If an new version of the Plug'n'Play standard is released and some extensions conflict with newly added
 * functions, they'll just have to fix the conflicts and bump their own version number.
 */

exports.VERSIONS = {std: 1};

/**
 * Useful when used together with getPackageInformation to fetch information about the top-level package.
 */

exports.topLevel = {name: null, reference: null};

/**
 * Gets the package information for a given locator. Returns null if they cannot be retrieved.
 */

exports.getPackageInformation = function getPackageInformation({name, reference}) {
  const packageInformationStore = packageInformationStores.get(name);

  if (!packageInformationStore) {
    return null;
  }

  const packageInformation = packageInformationStore.get(reference);

  if (!packageInformation) {
    return null;
  }

  return packageInformation;
};

/**
 * Transforms a request (what's typically passed as argument to the require function) into an unqualified path.
 * This path is called "unqualified" because it only changes the package name to the package location on the disk,
 * which means that the end result still cannot be directly accessed (for example, it doesn't try to resolve the
 * file extension, or to resolve directories to their "index.js" content). Use the "resolveUnqualified" function
 * to convert them to fully-qualified paths, or just use "resolveRequest" that do both operations in one go.
 *
 * Note that it is extremely important that the `issuer` path ends with a forward slash if the issuer is to be
 * treated as a folder (ie. "/tmp/foo/" rather than "/tmp/foo" if "foo" is a directory). Otherwise relative
 * imports won't be computed correctly (they'll get resolved relative to "/tmp/" instead of "/tmp/foo/").
 */

exports.resolveToUnqualified = function resolveToUnqualified(request, issuer, {considerBuiltins = true} = {}) {
  // Bailout if the request is a native module

  if (considerBuiltins && builtinModules.has(request)) {
    return null;
  }

  // We allow disabling the pnp resolution for some subpaths. This is because some projects, often legacy,
  // contain multiple levels of dependencies (ie. a yarn.lock inside a subfolder of a yarn.lock). This is
  // typically solved using workspaces, but not all of them have been converted already.

  if (ignorePattern && ignorePattern.test(issuer)) {
    const result = callNativeResolution(request, issuer);

    if (result === false) {
      throw makeError(
        `BUILTIN_NODE_RESOLUTION_FAIL`,
        `The builtin node resolution algorithm was unable to resolve the module referenced by "${request}" and requested from "${issuer}" (it didn't go through the pnp resolver because the issuer was explicitely ignored by the regexp "null")`,
        {
          request,
          issuer,
        },
      );
    }

    return result;
  }

  let unqualifiedPath;

  // If the request is a relative or absolute path, we just return it normalized

  const dependencyNameMatch = request.match(pathRegExp);

  if (!dependencyNameMatch) {
    if (path.isAbsolute(request)) {
      unqualifiedPath = path.normalize(request);
    } else if (issuer.match(isDirRegExp)) {
      unqualifiedPath = path.normalize(path.resolve(issuer, request));
    } else {
      unqualifiedPath = path.normalize(path.resolve(path.dirname(issuer), request));
    }
  }

  // Things are more hairy if it's a package require - we then need to figure out which package is needed, and in
  // particular the exact version for the given location on the dependency tree

  if (dependencyNameMatch) {
    const [, dependencyName, subPath] = dependencyNameMatch;

    const issuerLocator = exports.findPackageLocator(issuer);

    // If the issuer file doesn't seem to be owned by a package managed through pnp, then we resort to using the next
    // resolution algorithm in the chain, usually the native Node resolution one

    if (!issuerLocator) {
      const result = callNativeResolution(request, issuer);

      if (result === false) {
        throw makeError(
          `BUILTIN_NODE_RESOLUTION_FAIL`,
          `The builtin node resolution algorithm was unable to resolve the module referenced by "${request}" and requested from "${issuer}" (it didn't go through the pnp resolver because the issuer doesn't seem to be part of the Yarn-managed dependency tree)`,
          {
            request,
            issuer,
          },
        );
      }

      return result;
    }

    const issuerInformation = getPackageInformationSafe(issuerLocator);

    // We obtain the dependency reference in regard to the package that request it

    let dependencyReference = issuerInformation.packageDependencies.get(dependencyName);

    // If we can't find it, we check if we can potentially load it from the packages that have been defined as potential fallbacks.
    // It's a bit of a hack, but it improves compatibility with the existing Node ecosystem. Hopefully we should eventually be able
    // to kill this logic and become stricter once pnp gets enough traction and the affected packages fix themselves.

    if (issuerLocator !== topLevelLocator) {
      for (let t = 0, T = fallbackLocators.length; dependencyReference === undefined && t < T; ++t) {
        const fallbackInformation = getPackageInformationSafe(fallbackLocators[t]);
        dependencyReference = fallbackInformation.packageDependencies.get(dependencyName);
      }
    }

    // If we can't find the path, and if the package making the request is the top-level, we can offer nicer error messages

    if (!dependencyReference) {
      if (dependencyReference === null) {
        if (issuerLocator === topLevelLocator) {
          throw makeError(
            `MISSING_PEER_DEPENDENCY`,
            `You seem to be requiring a peer dependency ("${dependencyName}"), but it is not installed (which might be because you're the top-level package)`,
            {request, issuer, dependencyName},
          );
        } else {
          throw makeError(
            `MISSING_PEER_DEPENDENCY`,
            `Package "${issuerLocator.name}@${issuerLocator.reference}" is trying to access a peer dependency ("${dependencyName}") that should be provided by its direct ancestor but isn't`,
            {request, issuer, issuerLocator: Object.assign({}, issuerLocator), dependencyName},
          );
        }
      } else {
        if (issuerLocator === topLevelLocator) {
          throw makeError(
            `UNDECLARED_DEPENDENCY`,
            `You cannot require a package ("${dependencyName}") that is not declared in your dependencies (via "${issuer}")`,
            {request, issuer, dependencyName},
          );
        } else {
          const candidates = Array.from(issuerInformation.packageDependencies.keys());
          throw makeError(
            `UNDECLARED_DEPENDENCY`,
            `Package "${issuerLocator.name}@${issuerLocator.reference}" (via "${issuer}") is trying to require the package "${dependencyName}" (via "${request}") without it being listed in its dependencies (${candidates.join(
              `, `,
            )})`,
            {request, issuer, issuerLocator: Object.assign({}, issuerLocator), dependencyName, candidates},
          );
        }
      }
    }

    // We need to check that the package exists on the filesystem, because it might not have been installed

    const dependencyLocator = {name: dependencyName, reference: dependencyReference};
    const dependencyInformation = exports.getPackageInformation(dependencyLocator);
    const dependencyLocation = path.resolve(__dirname, dependencyInformation.packageLocation);

    if (!dependencyLocation) {
      throw makeError(
        `MISSING_DEPENDENCY`,
        `Package "${dependencyLocator.name}@${dependencyLocator.reference}" is a valid dependency, but hasn't been installed and thus cannot be required (it might be caused if you install a partial tree, such as on production environments)`,
        {request, issuer, dependencyLocator: Object.assign({}, dependencyLocator)},
      );
    }

    // Now that we know which package we should resolve to, we only have to find out the file location

    if (subPath) {
      unqualifiedPath = path.resolve(dependencyLocation, subPath);
    } else {
      unqualifiedPath = dependencyLocation;
    }
  }

  return path.normalize(unqualifiedPath);
};

/**
 * Transforms an unqualified path into a qualified path by using the Node resolution algorithm (which automatically
 * appends ".js" / ".json", and transforms directory accesses into "index.js").
 */

exports.resolveUnqualified = function resolveUnqualified(
  unqualifiedPath,
  {extensions = Object.keys(Module._extensions)} = {},
) {
  const qualifiedPath = applyNodeExtensionResolution(unqualifiedPath, {extensions});

  if (qualifiedPath) {
    return path.normalize(qualifiedPath);
  } else {
    throw makeError(
      `QUALIFIED_PATH_RESOLUTION_FAILED`,
      `Couldn't find a suitable Node resolution for unqualified path "${unqualifiedPath}"`,
      {unqualifiedPath},
    );
  }
};

/**
 * Transforms a request into a fully qualified path.
 *
 * Note that it is extremely important that the `issuer` path ends with a forward slash if the issuer is to be
 * treated as a folder (ie. "/tmp/foo/" rather than "/tmp/foo" if "foo" is a directory). Otherwise relative
 * imports won't be computed correctly (they'll get resolved relative to "/tmp/" instead of "/tmp/foo/").
 */

exports.resolveRequest = function resolveRequest(request, issuer, {considerBuiltins, extensions} = {}) {
  let unqualifiedPath;

  try {
    unqualifiedPath = exports.resolveToUnqualified(request, issuer, {considerBuiltins});
  } catch (originalError) {
    // If we get a BUILTIN_NODE_RESOLUTION_FAIL error there, it means that we've had to use the builtin node
    // resolution, which usually shouldn't happen. It might be because the user is trying to require something
    // from a path loaded through a symlink (which is not possible, because we need something normalized to
    // figure out which package is making the require call), so we try to make the same request using a fully
    // resolved issuer and throws a better and more actionable error if it works.
    if (originalError.code === `BUILTIN_NODE_RESOLUTION_FAIL`) {
      let realIssuer;

      try {
        realIssuer = realpathSync(issuer);
      } catch (error) {}

      if (realIssuer) {
        if (issuer.endsWith(`/`)) {
          realIssuer = realIssuer.replace(/\/?$/, `/`);
        }

        try {
          exports.resolveToUnqualified(request, realIssuer, {considerBuiltins});
        } catch (error) {
          // If an error was thrown, the problem doesn't seem to come from a path not being normalized, so we
          // can just throw the original error which was legit.
          throw originalError;
        }

        // If we reach this stage, it means that resolveToUnqualified didn't fail when using the fully resolved
        // file path, which is very likely caused by a module being invoked through Node with a path not being
        // correctly normalized (ie you should use "node $(realpath script.js)" instead of "node script.js").
        throw makeError(
          `SYMLINKED_PATH_DETECTED`,
          `A pnp module ("${request}") has been required from what seems to be a symlinked path ("${issuer}"). This is not possible, you must ensure that your modules are invoked through their fully resolved path on the filesystem (in this case "${realIssuer}").`,
          {
            request,
            issuer,
            realIssuer,
          },
        );
      }
    }
    throw originalError;
  }

  if (unqualifiedPath === null) {
    return null;
  }

  try {
    return exports.resolveUnqualified(unqualifiedPath, {extensions});
  } catch (resolutionError) {
    if (resolutionError.code === 'QUALIFIED_PATH_RESOLUTION_FAILED') {
      Object.assign(resolutionError.data, {request, issuer});
    }
    throw resolutionError;
  }
};

/**
 * Setups the hook into the Node environment.
 *
 * From this point on, any call to `require()` will go through the "resolveRequest" function, and the result will
 * be used as path of the file to load.
 */

exports.setup = function setup() {
  // A small note: we don't replace the cache here (and instead use the native one). This is an effort to not
  // break code similar to "delete require.cache[require.resolve(FOO)]", where FOO is a package located outside
  // of the Yarn dependency tree. In this case, we defer the load to the native loader. If we were to replace the
  // cache by our own, the native loader would populate its own cache, which wouldn't be exposed anymore, so the
  // delete call would be broken.

  const originalModuleLoad = Module._load;

  Module._load = function(request, parent, isMain) {
    if (!enableNativeHooks) {
      return originalModuleLoad.call(Module, request, parent, isMain);
    }

    // Builtins are managed by the regular Node loader

    if (builtinModules.has(request)) {
      try {
        enableNativeHooks = false;
        return originalModuleLoad.call(Module, request, parent, isMain);
      } finally {
        enableNativeHooks = true;
      }
    }

    // The 'pnpapi' name is reserved to return the PnP api currently in use by the program

    if (request === `pnpapi`) {
      return pnpModule.exports;
    }

    // Request `Module._resolveFilename` (ie. `resolveRequest`) to tell us which file we should load

    const modulePath = Module._resolveFilename(request, parent, isMain);

    // Check if the module has already been created for the given file

    const cacheEntry = Module._cache[modulePath];

    if (cacheEntry) {
      return cacheEntry.exports;
    }

    // Create a new module and store it into the cache

    const module = new Module(modulePath, parent);
    Module._cache[modulePath] = module;

    // The main module is exposed as global variable

    if (isMain) {
      process.mainModule = module;
      module.id = '.';
    }

    // Try to load the module, and remove it from the cache if it fails

    let hasThrown = true;

    try {
      module.load(modulePath);
      hasThrown = false;
    } finally {
      if (hasThrown) {
        delete Module._cache[modulePath];
      }
    }

    // Some modules might have to be patched for compatibility purposes

    if (patchedModules.has(request)) {
      module.exports = patchedModules.get(request)(module.exports);
    }

    return module.exports;
  };

  const originalModuleResolveFilename = Module._resolveFilename;

  Module._resolveFilename = function(request, parent, isMain, options) {
    if (!enableNativeHooks) {
      return originalModuleResolveFilename.call(Module, request, parent, isMain, options);
    }

    let issuers;

    if (options) {
      const optionNames = new Set(Object.keys(options));
      optionNames.delete('paths');

      if (optionNames.size > 0) {
        throw makeError(
          `UNSUPPORTED`,
          `Some options passed to require() aren't supported by PnP yet (${Array.from(optionNames).join(', ')})`,
        );
      }

      if (options.paths) {
        issuers = options.paths.map(entry => `${path.normalize(entry)}/`);
      }
    }

    if (!issuers) {
      const issuerModule = getIssuerModule(parent);
      const issuer = issuerModule ? issuerModule.filename : `${process.cwd()}/`;

      issuers = [issuer];
    }

    let firstError;

    for (const issuer of issuers) {
      let resolution;

      try {
        resolution = exports.resolveRequest(request, issuer);
      } catch (error) {
        firstError = firstError || error;
        continue;
      }

      return resolution !== null ? resolution : request;
    }

    throw firstError;
  };

  const originalFindPath = Module._findPath;

  Module._findPath = function(request, paths, isMain) {
    if (!enableNativeHooks) {
      return originalFindPath.call(Module, request, paths, isMain);
    }

    for (const path of paths) {
      let resolution;

      try {
        resolution = exports.resolveRequest(request, path);
      } catch (error) {
        continue;
      }

      if (resolution) {
        return resolution;
      }
    }

    return false;
  };

  process.versions.pnp = String(exports.VERSIONS.std);
};

exports.setupCompatibilityLayer = () => {
  // see https://github.com/browserify/resolve/blob/master/lib/caller.js
  const getCaller = () => {
    const origPrepareStackTrace = Error.prepareStackTrace;

    Error.prepareStackTrace = (_, stack) => stack;
    const stack = new Error().stack;
    Error.prepareStackTrace = origPrepareStackTrace;

    return stack[2].getFileName();
  };

  // ESLint currently doesn't have any portable way for shared configs to specify their own
  // plugins that should be used (https://github.com/eslint/eslint/issues/10125). This will
  // likely get fixed at some point, but it'll take time and in the meantime we'll just add
  // additional fallback entries for common shared configs.

  for (const name of [`react-scripts`]) {
    const packageInformationStore = packageInformationStores.get(name);
    if (packageInformationStore) {
      for (const reference of packageInformationStore.keys()) {
        fallbackLocators.push({name, reference});
      }
    }
  }

  // We need to shim the "resolve" module, because Liftoff uses it in order to find the location
  // of the module in the dependency tree. And Liftoff is used to power Gulp, which doesn't work
  // at all unless modulePath is set, which we cannot configure from any other way than through
  // the Liftoff pipeline (the key isn't whitelisted for env or cli options).

  patchedModules.set(/^resolve$/, realResolve => {
    const mustBeShimmed = caller => {
      const callerLocator = exports.findPackageLocator(caller);

      return callerLocator && callerLocator.name === 'liftoff';
    };

    const attachCallerToOptions = (caller, options) => {
      if (!options.basedir) {
        options.basedir = path.dirname(caller);
      }
    };

    const resolveSyncShim = (request, {basedir}) => {
      return exports.resolveRequest(request, basedir, {
        considerBuiltins: false,
      });
    };

    const resolveShim = (request, options, callback) => {
      setImmediate(() => {
        let error;
        let result;

        try {
          result = resolveSyncShim(request, options);
        } catch (thrown) {
          error = thrown;
        }

        callback(error, result);
      });
    };

    return Object.assign(
      (request, options, callback) => {
        if (typeof options === 'function') {
          callback = options;
          options = {};
        } else if (!options) {
          options = {};
        }

        const caller = getCaller();
        attachCallerToOptions(caller, options);

        if (mustBeShimmed(caller)) {
          return resolveShim(request, options, callback);
        } else {
          return realResolve.sync(request, options, callback);
        }
      },
      {
        sync: (request, options) => {
          if (!options) {
            options = {};
          }

          const caller = getCaller();
          attachCallerToOptions(caller, options);

          if (mustBeShimmed(caller)) {
            return resolveSyncShim(request, options);
          } else {
            return realResolve.sync(request, options);
          }
        },
        isCore: request => {
          return realResolve.isCore(request);
        },
      },
    );
  });
};

if (module.parent && module.parent.id === 'internal/preload') {
  exports.setupCompatibilityLayer();

  exports.setup();
}

if (process.mainModule === module) {
  exports.setupCompatibilityLayer();

  const reportError = (code, message, data) => {
    process.stdout.write(`${JSON.stringify([{code, message, data}, null])}\n`);
  };

  const reportSuccess = resolution => {
    process.stdout.write(`${JSON.stringify([null, resolution])}\n`);
  };

  const processResolution = (request, issuer) => {
    try {
      reportSuccess(exports.resolveRequest(request, issuer));
    } catch (error) {
      reportError(error.code, error.message, error.data);
    }
  };

  const processRequest = data => {
    try {
      const [request, issuer] = JSON.parse(data);
      processResolution(request, issuer);
    } catch (error) {
      reportError(`INVALID_JSON`, error.message, error.data);
    }
  };

  if (process.argv.length > 2) {
    if (process.argv.length !== 4) {
      process.stderr.write(`Usage: ${process.argv[0]} ${process.argv[1]} <request> <issuer>\n`);
      process.exitCode = 64; /* EX_USAGE */
    } else {
      processResolution(process.argv[2], process.argv[3]);
    }
  } else {
    let buffer = '';
    const decoder = new StringDecoder.StringDecoder();

    process.stdin.on('data', chunk => {
      buffer += decoder.write(chunk);

      do {
        const index = buffer.indexOf('\n');
        if (index === -1) {
          break;
        }

        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);

        processRequest(line);
      } while (true);
    });
  }
}

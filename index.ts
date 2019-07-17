import * as fs from 'fs';
import * as path from 'path';
import { createFilter } from 'rollup-pluginutils';
import { SourceNode, SourceMapConsumer, RawSourceMap, SourceMapGenerator } from 'source-map';
import { ParsedTemplate, CompileOptions } from '@endorphinjs/template-compiler';
const mkdirp = require('mkdirp');

type TransformedResource = string | Buffer | {
    code?: string | Buffer,
    css?: string | Buffer,
    map?: any
};
type TransformedResult = string | CodeWithMap;
type CodeWithMap = { code: string, map?: any };

interface ResourceTransformer {
    (type: string, code: string, filename: string): TransformedResource | Promise<TransformedResource>;
}

interface CSSBundleHandler {
    (code: string, map?: SourceMapGenerator): void;
}

interface EndorphinPluginOptions {
    /**
     * List of file extensions which should be treated as Endorphin template.
     * Default are `.html` and `.end`
     */
    extensions?: string[],

    include?: string | string[],
    exclude?: string | string[],


    /** Mapping of type attributes of style and script tags to extension */
    types: { [type: string]: string };

    /** Additional options for template compiler */
    template?: CompileOptions;

    /** Options for CSS processing */
    css?: {
        /** A function to transform stylesheet code. */
        preprocess?: ResourceTransformer;

        /** A function that returns a CSS scope token from given component file path */
        scope?: (fileName: string) => string;

        /**
         * Path where CSS bundle should be saved or function which accepts generated
         * CSS bundle and its source map
         */
        bundle?: string | CSSBundleHandler;
    };
}

const defaultScriptType = 'text/javascript';
const defaultStyleType = 'text/css';
const defaultOptions: EndorphinPluginOptions = {
    extensions: ['.html', '.end'],
    types: {
        [defaultScriptType]: '.js',
        [defaultStyleType]: '.css',
        'typescript': '.ts',
        'ts': '.ts',
        'javascript': '.js',
        'sass': '.sass',
        'scss': '.scss'
    }
};

const defaultCSSOptions = {
    scope(filePath: string): string {
        // A simple function for calculation of has (Adler32) from given string
        let s1 = 1, s2 = 0;
        for (let i = 0, len = filePath.length; i < len; i++) {
            s1 = (s1 + filePath.charCodeAt(i)) % 65521;
            s2 = (s2 + s1) % 65521;
        }
        return 'e' + ((s2 << 16) + s1).toString(36);
    }
}

export default function endorphin(options?: EndorphinPluginOptions): object {
    options = {
        ...defaultOptions,
        ...options
    };

    if (!options.css) {
        options.css = defaultCSSOptions;
    } else {
        options.css = {
            ...defaultCSSOptions,
            ...options.css
        };
    }

    const filter = createFilter(options.include, options.exclude);
    const jsResources = {};
    const cssResources: Map<string, SourceNode> = new Map();
    const endorphin = require('endorphin/compiler');

    return {
        name: 'endorphin',

        load(id: string) {
            return id in jsResources ? jsResources[id] : null;
        },

        resolveId(id: string) {
            return id in jsResources ? id : null;
        },

        async transform(this: any, source: string, id: string) {
            if (!filter(id) || !options.extensions.includes(path.extname(id))) {
                return null;
            }

            const cssScope = options.css.scope(id);

            // Parse Endorphin template into AST
            const parsed = endorphin.parse(source, id, options.template) as ParsedTemplate;
            const { scripts, stylesheets } = parsed.ast;

            // For inline scripts, emit source code as external module so we can
            // hook on it’s processing
            scripts.forEach((script, i) => {
                if (script.content) {
                    let assetUrl = createAssetUrl(parsed.url, options.types[script.mime] || options.types[defaultScriptType], i);
                    if (assetUrl[0] !== '.' && assetUrl[0] !== '/' && assetUrl[0] !== '@') {
                        assetUrl = `./${assetUrl}`;
                    }
                    jsResources[assetUrl] = script.transformed || script.content;
                    script.url = assetUrl;
                    script.transformed = script.content = void 0;
                }
            });

            // Process stylesheets: apply custom transform (if required) and scope
            // CSS selectors
            await Promise.all(stylesheets.map(async (stylesheet) => {
                const isExternal = stylesheet.url !== id;
                // XXX when resolved via `this.resolveId()`, a file name could lead
                // to Node module resolve, e.g. `my-file.css` can be resolved as
                // `node_modules/my-file.css/index.js`
                // let fullId = await this.resolveId(stylesheet.url, id);
                let fullId = path.resolve(path.dirname(id), stylesheet.url);
                let content = '';

                if (isExternal) {
                    // Watch for external stylesheets
                    this.addWatchFile(fullId);
                    content = fs.readFileSync(fullId, 'utf8');
                } else {
                    content = stylesheet.content;
                }

                let transformed: CodeWithMap = { code: content };

                // Apply custom CSS preprocessing
                if (typeof options.css.preprocess === 'function') {
                    const result = await transformResource(stylesheet.mime, content, fullId, options.css.preprocess);
                    if (result != null) {
                        transformed = result;
                    }
                }

                // Isolate CSS selector with scope token
                if (cssScope) {
                    let filename = fullId;
                    let map = transformed.map;

                    if (typeof map === 'string') {
                        map = JSON.parse(map);
                    }

                    if (map && map.file) {
                        filename = map.file;
                    }

                    const scoped = await endorphin.scopeCSS(transformed.code, cssScope, { filename, map });
                    transformed = typeof scoped === 'string' ? { code: scoped } : scoped;
                }

                const node = await nodeFromTransformed(transformed, content, fullId);
                cssResources.set(fullId, node);
            }));

            // Generate JavaScript code from template AST
            return endorphin.generate(parsed, {
                module: 'endorphin',
                cssScope,
                warn: (msg: string, pos?: number) => this.warn(msg, pos),
                ...options.template
            });
        },

        async generateBundle(outputOptions: any) {
            if (!options.css.bundle) {
                return;
            }

            const output = new SourceNode();
            for (const node of cssResources.values()) {
                output.add(node);
            }

            let code: string, map: SourceMapGenerator;

            if (outputOptions.sourcemap) {
                const result = output.toStringWithSourceMap();
                code = result.code;
                map = result.map;
            } else {
                code = output.toString();
            }

            if (typeof options.css.bundle === 'function') {
                return options.css.bundle(code, map);
            } else {
                const dir = path.dirname(options.css.bundle);
                mkdirp.sync(dir);

                if (map) {
                    const sourceMapPath = path.basename(options.css.bundle) + '.map';
                    const fullSourceMapPath = path.join(dir, sourceMapPath);
                    code += `\n/*# sourceMappingURL=${sourceMapPath} */`;
                    fs.writeFileSync(fullSourceMapPath, map.toString());
                }
                fs.writeFileSync(options.css.bundle, code);
            }
        }
    };
}

async function transformResource(type: string, content: string, url: string, transformer: ResourceTransformer): Promise<CodeWithMap> {
    const transformed: TransformedResource = await transformer(type, content, url);

    const result: TransformedResource = typeof transformed === 'string' || Buffer.isBuffer(transformed)
        ? { code: transformed }
        : transformed;

    let code = result.css || result.code;
    let map = result.map;

    if (Buffer.isBuffer(code)) {
        code = code.toString()
    }

    if (Buffer.isBuffer(map)) {
        map = map.toString();
    }

    if (map && map.addMapping) {
        // Source map is a SourceMapGenerator
        result.map = result.map.toJSON();
    }

    return { code, map };
}

async function nodeFromTransformed(data: TransformedResult, source: string, fileName?: string): Promise<SourceNode> {
    let node: SourceNode;

    if (typeof data === 'object' && data.map) {
        const consumer = await new SourceMapConsumer(data.map as RawSourceMap);
        node = SourceNode.fromStringWithSourceMap(data.code, consumer);
    } else {
        node = new SourceNode();
        node.add(typeof data === 'string' ? data : data.code);
    }

    node.setSourceContent(fileName, source);
    return node;
}

function createAssetUrl(baseUrl: string, ext: string, index: number = 0): string {
    const baseName = baseUrl.slice(0, -path.extname(baseUrl).length);
    return `${baseName}_${index}${ext}`;
}

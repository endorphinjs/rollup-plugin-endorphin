import * as fs from 'fs';
import * as path from 'path';
import { PluginContext } from 'rollup';
import { createFilter } from 'rollup-pluginutils';
import { generate, parse } from '@endorphinjs/template-compiler';
import { SourceNode, SourceMapConsumer } from 'source-map';

type TransformedResource = string | Buffer | { code: string | Buffer, map: any }

interface ResourceTransformer {
    (type: string, code: string, filename: string): TransformedResource | Promise<TransformedResource>;
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

    /**
     * A function to transform stylesheet code.
     */
    css?: ResourceTransformer;

    /** Path where CSS bundle should be saved */
    cssBundle?: string;
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

export function endorphin(options?: EndorphinPluginOptions): object {
    const opts: EndorphinPluginOptions = {
        ...defaultOptions,
        ...options
    };
    const filter = createFilter(opts.include, opts.exclude);
    const jsResources = {};
    const cssResources: Map<string, SourceNode> = new Map();

    return {
        name: 'endorphin',

        load(id: string) {
            if (id in jsResources) {
                return jsResources[id];
            }

            return null;
        },

        resolveId(id: string) {
            if (id in jsResources) {
                return id;
            }
            return null;
        },
        
        async transform(this: PluginContext, source: string, id: string) {
            if (!filter(id) || !opts.extensions.includes(path.extname(id))) {
                return null;
            }

            const parsed = parse(source, id);
            const { scripts, stylesheets } = parsed.ast;

            // For inline styles, emit source code as external module so we can 
            // hook on it’s processing
            scripts.forEach((script, i) => {
                if (script.content) {
                    const assetUrl = createAssetUrl(parsed.url, opts.types[script.mime] || opts.types[defaultScriptType], i);
                    jsResources[assetUrl] = script.content.value;
                    script.content.value = `export * from "${assetUrl}";`;
                }
            });

            await Promise.all(stylesheets.map(async (stylesheet, i) => {
                const isExternal = stylesheet.url !== id;
                let fullId = await this.resolveId(stylesheet.url, id) as string;
                let content = '';
                
                if (isExternal) {
                    // Watch for external stylesheets
                    this.addWatchFile(stylesheet.url);
                    content = fs.readFileSync(fullId, 'utf8');
                } else {
                    content = stylesheet.content.value;
                }

                const node = await transformResource(stylesheet.mime, content, fullId, opts.css);
                if (isExternal) {
                    node.setSourceContent(content, fullId);
                } else {
                    node.setSourceContent(source, id);
                }

                cssResources.set(fullId, node);
            }));

            return generate(parsed, {
                module: '@endorphinjs/template-runtime'
            });
        },

        generateBundle(outputOptions: any) {
            if (!opts.cssBundle) {
                return;
            }

            const output = new SourceNode();
            for (const node of cssResources.values()) {
                output.add(node);
            }

            if (!outputOptions.sourcemap) {
                fs.writeFileSync(opts.cssBundle, output.toString());
            } else {
                const sourceMapPath = path.basename(opts.cssBundle) + '.map';
                const fullSourceMapPath = path.join(path.dirname(opts.cssBundle), sourceMapPath);
                const result = output.toStringWithSourceMap();
                fs.writeFileSync(opts.cssBundle, result.code + `\n/*# sourceMappingURL=${sourceMapPath} */`);
                fs.writeFileSync(fullSourceMapPath, result.map.toString());
            }
        }
    };
}

async function transformResource(type: string, content: string, url: string, transformer: ResourceTransformer): Promise<SourceNode> {
    let transformed: TransformedResource;
    if (transformer) {
        transformed = await transformer(type, content, url);
    }

    if (Buffer.isBuffer(transformed)) {
        transformed = transformed.toString();
    }

    let node: SourceNode;

    if (transformed && typeof transformed === 'object') {
        const consumer = await new SourceMapConsumer(transformed.map);
        const code = transformed.code.toString();
        node = SourceNode.fromStringWithSourceMap(code, consumer);
    } else {
        node = new SourceNode();
        if (transformed && typeof transformed === 'string') {
            node.add(transformed);
        } 
    }

    return node;
}

function createAssetUrl(baseUrl: string, ext: string, index: number = 0): string {
    const baseName = baseUrl.slice(0, -path.extname(baseUrl).length);
    return `${baseName}_${index}${ext}`;
}
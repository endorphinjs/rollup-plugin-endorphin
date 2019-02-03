const path = require('path');
const { endorphin } = require('./');
const commonjs = require('rollup-plugin-commonjs');
const resolve = require('rollup-plugin-node-resolve');
const sass = require('node-sass');

export default {
    input: './test/samples/set1/my-component.html',
    plugins: [
        resolve(),
        commonjs(),
        endorphin({
            cssBundle: path.resolve(__dirname, 'dist/set1.css'),
            css(type, content, file) {
                if (type === 'scss') {
                    const result = sass.renderSync({
                        file,
                        data: content,
                        sourceMap: true,
                        outFile: file.replace(/\.\w+$/, '.css'),
                        omitSourceMapUrl: true,
                        sourceMapContents: true
                    });

                    result.map = JSON.parse(result.map);
                    return {
                        code: result.css,
                        map: result.map
                    };
                }

                return content;
            }
        })
    ],
    output: {
        format: 'iife',
        file: './dist/set1.js',
        name: 'set1',
        exports: 'named',
        sourcemap: true
    }
};

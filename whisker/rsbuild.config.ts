import { defineConfig, loadEnv } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginTypeCheck } from '@rsbuild/plugin-type-check';

const { publicVars } = loadEnv({ prefixes: ['APP_'] });

export default defineConfig({
    plugins: [pluginReact(), pluginTypeCheck()],
    server: {
        port: 3000,
        proxy: {
            '/flows': 'http://localhost:3002',
            '/flows-filter-hints': 'http://localhost:3002',
            '/statistics': 'http://localhost:3002',
            '/policy': 'http://localhost:3002',
        },
    },
    html: {
        template: './index.html',
    },
    source: {
        entry: {
            index: './src/main.tsx',
        },
        define: publicVars,
    },
    output: {
        copy: [
            {
                from: 'public/favicon.ico',
                to: 'public/favicon.ico',
            },
        ],
    },
});

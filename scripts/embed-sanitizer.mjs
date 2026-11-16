import { readFileSync, writeFileSync } from 'node:fs';
const path = 'studio/studio.html';
let html = readFileSync(path, 'utf8');
const vendor = readFileSync('node_modules/dompurify/dist/purify.min.js', 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
const block = '<!-- sanitizer:start -->\n<script>' + vendor + '</script>\n<!-- sanitizer:end -->';
html = html.includes('<!-- sanitizer:start -->') ? html.replace(/<!-- sanitizer:start -->[\s\S]*?<!-- sanitizer:end -->/, () => block) : html.replace('</head>', block + '\n</head>');
writeFileSync(path, html);

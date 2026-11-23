import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = process.env.RESVG_DIR
  ? resolve(process.env.RESVG_DIR, 'node_modules/@resvg/resvg-js')
  : '@resvg/resvg-js';
const { Resvg } = require(pkg);

// usage: node render.mjs <svg> <png> <size>
const [svgPath, pngPath, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg || 512);
const svg = readFileSync(resolve(svgPath), 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: size },
  background: 'rgba(0,0,0,0)',
});
const png = resvg.render().asPng();
mkdirSync(dirname(resolve(pngPath)), { recursive: true });
writeFileSync(resolve(pngPath), png);
console.log(`${pngPath} ${size}px`);

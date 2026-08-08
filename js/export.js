/**
 * @module export
 * Экспорт расставленной позиции в самостоятельный SVG-файл для шаринга.
 *
 * Решение по палитре: SVG рисуется в УНИВЕРСАЛЬНОЙ классической палитре
 * (тёплый орех + слоновая кость + точёные шашки), а не в цветах текущего
 * скина — файл-картинка должен читаться на любом фоне (белая страница,
 * тёмный чат). Текстуры скинов (ткань/дерево через repeating-gradient)
 * в вектор без потерь не переносятся, поэтому берётся чистый классический вид.
 *
 * Ориентация и раскладка координат берутся ЧЕСТНО из отрисованного DOM,
 * поэтому перевёрнутая доска сохраняется перевёрнутой. Чёрные фигуры несут
 * светлый ореол (как на экране), чтобы не сливаться с тёмными полями.
 */

import { formatDate } from './pdn.js';
import { showToast } from './toast.js';
import { saveFileWithPicker } from './storage.js';

/** Скачивание SVG-текста как файла с корректным MIME image/svg+xml. */
async function downloadSVG(filename, svgText) {
  const res = await saveFileWithPicker(filename, svgText, 'image/svg+xml', { description: 'Позиция SVG', extensions: ['.svg'] });
  return res;
}


/**
 * Собирает SVG текущей доски прямо из отрисованного DOM и скачивает файл.
 * Читает порядок клеток, свет/тьму полей, фигуры и подписи координат из
 * готовой разметки — экспорт совпадает с экраном и учитывает переворот.
 */
export async function saveSetupSVG() {
  const boardEl = document.getElementById('board');
  const squares = boardEl ? [...boardEl.children] : [];
  if (squares.length !== 64) { showToast('Доска не готова для экспорта', 'error'); return; }

  const fileLabels = [...document.querySelectorAll('.coords-top span')].map((s) => s.textContent);
  const rankLabels = [...document.querySelectorAll('.coords-left span')].map((s) => s.textContent);

  const N = 8, cell = 64, coord = 24, frame = 14;
  const boardPx = N * cell;
  const W = boardPx + 2 * coord + 2 * frame;
  const ox = frame + coord, oy = frame + coord;

  const C = {
    lightA: '#f4ddb2', lightB: '#e7c890', darkA: '#9c6c3f', darkB: '#7c4f2a',
    frameHi: '#6e4826', frameMid: '#4a2f15', frameLo: '#3a2410',
    coord: '#cfa86c', boardEdge: '#241305',
  };

  const cells = [], pieces = [], files = [], ranks = [];
  for (let i = 0; i < 64; i++) {
    const r = (i / N) | 0, c = i % N;
    const x = ox + c * cell, y = oy + r * cell;
    const light = squares[i].classList.contains('sq-light');
    cells.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="url(#${light ? 'lg' : 'dg'})"/>`);

    const p = squares[i].querySelector('.piece');
    if (p) {
      const white = p.classList.contains('white');
      const king = p.classList.contains('king');
      const cx = x + cell / 2, cy = y + cell / 2, rr = cell * 0.38;
      const grad = white ? 'pw' : 'pb';
      const edge = white ? 'rgba(90,60,20,.35)' : 'rgba(255,248,232,.6)';
      const ring = white ? 'rgba(122,82,32,.4)' : 'rgba(0,0,0,.55)';
      pieces.push(
        `<g filter="url(#ds)">` +
        `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="url(#${grad})" stroke="${edge}" stroke-width="1.5"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${(rr * 0.7).toFixed(2)}" fill="none" stroke="${ring}" stroke-width="2"/>` +
        (king ? `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${(cell * 0.46).toFixed(1)}" fill="${white ? '#e9b84e' : '#f7d67e'}" style="font-family:serif">✦</text>` : '') +
        `</g>`
      );
    }

    if (fileLabels[c]) {
      const fx = x + cell / 2;
      files.push(`<text x="${fx}" y="${frame + coord / 2}" text-anchor="middle" dominant-baseline="central" class="co">${fileLabels[c]}</text>`);
      files.push(`<text x="${fx}" y="${oy + boardPx + coord / 2}" text-anchor="middle" dominant-baseline="central" class="co">${fileLabels[c]}</text>`);
    }
    if (rankLabels[r]) {
      const fy = y + cell / 2;
      ranks.push(`<text x="${frame + coord / 2}" y="${fy}" text-anchor="middle" dominant-baseline="central" class="co">${rankLabels[r]}</text>`);
      ranks.push(`<text x="${ox + boardPx + coord / 2}" y="${fy}" text-anchor="middle" dominant-baseline="central" class="co">${rankLabels[r]}</text>`);
    }
  }

  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
<defs>
<linearGradient id="fr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.frameHi}"/><stop offset=".55" stop-color="${C.frameMid}"/><stop offset="1" stop-color="${C.frameLo}"/></linearGradient>
<radialGradient id="lg" cx=".32" cy=".26" r="1"><stop offset="0" stop-color="${C.lightA}"/><stop offset="1" stop-color="${C.lightB}"/></radialGradient>
<radialGradient id="dg" cx=".32" cy=".26" r="1"><stop offset="0" stop-color="${C.darkA}"/><stop offset="1" stop-color="${C.darkB}"/></radialGradient>
<radialGradient id="pw" cx=".34" cy=".30" r=".75"><stop offset="0" stop-color="#fffdf4"/><stop offset=".42" stop-color="#f0debb"/><stop offset=".78" stop-color="#d3b17c"/><stop offset="1" stop-color="#b28a4e"/></radialGradient>
<radialGradient id="pb" cx=".34" cy=".30" r=".75"><stop offset="0" stop-color="#7a6049"/><stop offset=".45" stop-color="#3c2c1e"/><stop offset=".8" stop-color="#241811"/><stop offset="1" stop-color="#120b07"/></radialGradient>
<filter id="ds" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity=".45"/></filter>
<style>.co{font:700 13px ui-monospace,monospace;fill:${C.coord}}</style>
</defs>
<rect x="0" y="0" width="${W}" height="${W}" rx="14" fill="url(#fr)"/>
<rect x="${ox - 2}" y="${oy - 2}" width="${boardPx + 4}" height="${boardPx + 4}" fill="none" stroke="${C.boardEdge}" stroke-width="2"/>
${cells.join('\n')}
${files.join('\n')}
${ranks.join('\n')}
${pieces.join('\n')}
</svg>`;

  const res = await downloadSVG(`shashki-position-${formatDate().replace(/\./g, '-')}.svg`, svg);
  if (res) showToast('Позиция сохранена в SVG');
}
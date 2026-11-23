import { readFileSync } from 'node:fs';
const src = readFileSync('js/ui.js', 'utf8');
const lines = src.split('\n');
const stack = ['code'];
const BS = String.fromCharCode(92);
const marks = [];
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let inLine = false;
    for (let j = 0; j < line.length; j++) {
        const ch = line[j], next = line[j+1];
        const top = stack[stack.length - 1];
        if (inLine) continue;
        if (top === 'code') {
            if (ch === '/' && next === '/') { inLine = true; continue; }
            if (ch === '/' && next === '*') { stack.push('block'); j++; continue; }
            if (ch === '`') { stack.push('template'); continue; }
            if (ch === '(' || ch === '[' || ch === '{') stack.push('code');
            else if (ch === ')' || ch === ']' || ch === '}') { if (stack.length > 1) stack.pop(); }
            continue;
        }
        if (top === 'block') { if (ch === '*' && next === '/') { stack.pop(); j++; } continue; }
        if (ch === BS) { j++; continue; }
        if (ch === '`') { stack.pop(); continue; }
        if (ch === '$' && next === '{') { stack.push('code'); j++; continue; }
    }
    marks.push([i + 1, stack.length]);
}
console.log('final depth', marks[marks.length-1][1]);
let prev = 2;
for (let k = 0; k < marks.length; k++) {
    const [ln, d] = marks[k];
    if (ln > 640 && d !== prev) {
        console.log(`${ln}: ${prev} -> ${d} | ${lines[ln-1].trim().slice(0, 78)}`);
        prev = d;
    }
}

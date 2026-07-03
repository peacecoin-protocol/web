// Seed-deterministic 5x5 mirrored-pattern identicons for agents (no dependencies).
// Same (simSeed, agentId) always yields the same icon; color follows the persona
// hue with per-agent lightness/saturation jitter so individuals stay tellable.
import { mulberry32 } from './engine.js';

// Persona base hues (HSL), matching PERSONA_COLORS in network-view.js
// (blue / aqua / yellow / green / violet / red / magenta / orange).
const PERSONA_HSL = [
    [212, 67, 50],
    [159, 73, 40],
    [41, 100, 47],
    [120, 100, 26],
    [250, 49, 44],
    [0, 73, 59],
    [338, 70, 70],
    [17, 82, 56],
];

// 3 columns x 5 rows = 15 bits, mirrored to a 5x5 grid. Exported for tests.
export function patternBits(simSeed, agentId) {
    const seed = (Math.imul(simSeed, 0x9E3779B9) ^ Math.imul(agentId + 1, 0x85EBCA6B)) >>> 0;
    const rng = mulberry32(seed);
    let bits = 0;
    for (let i = 0; i < 15; i++) {
        if (rng() < 0.5) bits |= 1 << i;
    }
    // jitter values derived from the same stream keep color deterministic too
    const satJitter = (rng() - 0.5) * 20;
    const lightJitter = (rng() - 0.5) * 24;
    return { bits, satJitter, lightJitter };
}

const cache = new Map();

export function identiconURL(agentId, simSeed, personaIdx, size = 24) {
    const key = `${simSeed}:${agentId}:${personaIdx}:${size}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (cache.size > 5000) cache.clear(); // sweeps share seeds: keep it bounded

    const { bits, satJitter, lightJitter } = patternBits(simSeed, agentId);
    const [h, s, l] = PERSONA_HSL[personaIdx % PERSONA_HSL.length];
    const fill = `hsl(${h}, ${Math.max(20, Math.min(100, s + satJitter))}%, ${Math.max(22, Math.min(68, l + lightJitter))}%)`;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = size * dpr;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f1f0ec';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = fill;
    const cell = px / 5;
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
            if (!(bits & (1 << (row * 3 + col)))) continue;
            ctx.fillRect(col * cell, row * cell, cell + 0.5, cell + 0.5);
            const mirror = 4 - col;
            if (mirror !== col) ctx.fillRect(mirror * cell, row * cell, cell + 0.5, cell + 0.5);
        }
    }
    const url = canvas.toDataURL();
    cache.set(key, url);
    return url;
}

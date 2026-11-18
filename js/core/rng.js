/* ============================================================
 * 战役核心 · 确定性 PRNG（rng.js）
 * 算法：xoshiro256**（Vigna, 2018），BigInt 实现，跨引擎逐位一致。
 * 铁律：绝不使用 Math.random；状态必须可序列化进存档。
 * ============================================================ */

const M64 = 0xFFFFFFFFFFFFFFFFn;

/** 64 位循环左移（mod 2^64） */
function rotl64(x, k) {
    return ((x << k) | (x >> (64n - k))) & M64;
}

/** SplitMix64：把任意种子展开为 64 位均匀字，用于初始化状态 */
function splitMix64(seed) {
    let z = (BigInt(seed) + 0x9E3779B97F4A7C15n) & M64;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
    return (z ^ (z >> 31n)) & M64;
}

export class Rng {
    /**
     * @param {number|bigint} seed 种子（数字或 BigInt）
     */
    constructor(seed = 0x1936) {
        this.seed(seed);
    }

    seed(seed) {
        const z = BigInt(seed) & M64;
        // 用 SplitMix64 连续展开 4 个 64 位字作为初始状态
        this.s = [
            splitMix64(z),
            splitMix64(z ^ 0x123456789ABCDEFn),
            splitMix64(z ^ 0xDEADBEEFCAFEBABEn),
            splitMix64(z ^ 0xCAFEBABECAFEBABEn),
        ];
        return this;
    }

    /** xoshiro256** 主循环，返回 64 位无符号整数 */
    next() {
        const s0 = this.s[0], s1 = this.s[1], s2 = this.s[2], s3 = this.s[3];
        const result = (rotl64((s0 * 0x9E3779B1n) & M64, 5n) * 5n) & M64;
        const t = ((s1 << 17n) | (s1 >> 47n)) & M64;
        this.s[2] = (s2 ^ s0) & M64;
        this.s[3] = (s3 ^ s1) & M64;
        this.s[1] = (s1 ^ this.s[2]) & M64;
        this.s[0] = (s0 ^ this.s[3] ^ t) & M64;
        this.s[2] = (this.s[2] ^ rotl64(this.s[2], 45n)) & M64;
        return result;
    }

    /** 32 位无符号整数（取高 32 位，避开低位的弱位） */
    nextUint32() {
        return Number((this.next() >> 32n) & 0xFFFFFFFFn);
    }

    /** [0, 1) 浮点 */
    nextFloat() {
        return this.nextUint32() / 0x100000000;
    }

    /** [0, max) 整数 */
    nextInt(max) {
        if (max <= 0) return 0;
        return this.nextUint32() % max;
    }

    /** [min, max) 整数 */
    rangeInt(min, max) {
        return min + this.nextInt(max - min);
    }

    /** 从非空数组中等概率取一个元素 */
    pick(arr) {
        return arr[this.nextInt(arr.length)];
    }

    /** Fisher-Yates 洗牌，返回新数组（不改动原数组） */
    shuffle(arr) {
        const out = arr.slice();
        for (let i = out.length - 1; i > 0; i--) {
            const j = this.nextInt(i + 1);
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }

    /**
     * 序列化状态：4 × uint64 大端字节，共 32 字节。
     * 对应存档中的 rngState.bin。
     */
    getState() {
        const bytes = new Uint8Array(32);
        const dv = new DataView(bytes.buffer);
        for (let i = 0; i < 4; i++) {
            let v = this.s[i];
            for (let b = 7; b >= 0; b--) {
                dv.setUint8(i * 8 + b, Number(v & 0xFFn));
                v >>= 8n;
            }
        }
        return bytes;
    }

    /** 从 32 字节大端数据恢复状态（接受 Uint8Array 或普通数组——JSON 序列化后 TypedArray 会退化） */
    loadState(bytes) {
        const u8 = ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        this.s = [];
        for (let i = 0; i < 4; i++) {
            let v = 0n;
            for (let b = 0; b < 8; b++) {
                v = (v << 8n) | BigInt(dv.getUint8(i * 8 + b));
            }
            this.s[i] = v & M64;
        }
        return this;
    }

    clone() {
        const r = Object.create(Rng.prototype);
        r.s = this.s.slice();
        return r;
    }
}

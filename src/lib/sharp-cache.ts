/**
 * Disables sharp's own operation cache (native, in-process, on by default —
 * up to 100 files / 500 operations / 50MB of decoded pixel data retained to
 * speed up re-processing the SAME image). This app never re-processes the
 * same image twice in a way that cache would help: every upload, export, and
 * vision pass touches a distinct file exactly once. Left at its default, a
 * single large batch (bulk upload, bulk ZIP export) fills that cache with
 * genuinely one-shot decoded data, which is exactly the "memory grows with
 * batch size instead of staying flat" failure mode P4 set out to eliminate —
 * confirmed by `scripts/bench-memory.ts` showing close-to-linear RSS growth
 * with file count until this was disabled.
 *
 * Imported for its side effect only, once, by every module that imports
 * `sharp` — the cache is a single process-wide native setting, so it only
 * needs to run once, but importing it from each call site (rather than
 * relying on module load order) makes it true regardless of which route
 * happens to load first.
 */
import sharp from 'sharp'

sharp.cache(false)

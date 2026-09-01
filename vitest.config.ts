import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only scan the test tree. The default `**/*.test.ts` glob would also walk
    // `out/` (book captures plus persistent Chrome profiles), which is huge and
    // makes every `vitest run` take minutes just to discover test files.
    include: ['test/**/*.test.ts'],
    watch: false
  }
})

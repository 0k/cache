/// <reference types="vitest" />
import { defineConfig } from 'vite'

const cfg = defineConfig({
    test: {
        include: ['src/**/*.{js,ts}'],
        environment: 'jsdom',
        passWithNoTests: true,
        bail: 1,
    },
})

export default cfg

/**
 * Unit tests for ToolIcon.vue.
 *
 * Covers the 10 canonical Agent CLI tool names (Read / Edit / Write /
 * Bash / Grep / Glob / Agent / WebSearch / WebFetch / TodoWrite), the
 * unknown-tool wrench fallback, and the three dynamic status states
 * (running / done / error) which override the mapped icon.
 *
 * We render the component with happy-dom and assert on the emitted
 * `<svg>` element's lucide-* class and data-attributes — lucide-vue-next
 * outputs SVGs with a stable `lucide-<kebab-case>` class per icon, so
 * the class list uniquely identifies which icon rendered without
 * depending on the exact SVG path shape.
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolIcon from '../ToolIcon.vue'

/** Pull the `<svg>` element from a mounted ToolIcon and return its
 *  class list so we can assert which lucide icon rendered. */
function iconClasses(wrapper: ReturnType<typeof mount>): string[] {
  const svg = wrapper.find('svg')
  expect(svg.exists()).toBe(true)
  return (svg.attributes('class') ?? '').split(/\s+/)
}

describe('ToolIcon — tool name → Lucide icon mapping', () => {
  // Note: lucide-vue-next 1.x ships canonical kebab-case class names that
  // differ from the legacy aliased component names:
  //   Edit3 → pen-line, CheckCircle2 → circle-check, XCircle → circle-x,
  //   Loader2 → loader-circle, DownloadCloud → cloud-download, Globe2 → earth.
  // We assert on the canonical classes the current lucide build emits.
  const cases: Array<[string, string]> = [
    ['Read', 'lucide-book-open'],
    ['Edit', 'lucide-pen-line'],
    ['Write', 'lucide-file-plus'],
    ['Bash', 'lucide-terminal'],
    ['Grep', 'lucide-search-code'],
    ['Glob', 'lucide-folder-search'],
    ['Agent', 'lucide-bot'],
    ['WebSearch', 'lucide-earth'],
    ['WebFetch', 'lucide-cloud-download'],
    ['TodoWrite', 'lucide-list-checks'],
  ]

  for (const [tool, expectedClass] of cases) {
    it(`renders ${expectedClass} for tool="${tool}"`, () => {
      const wrapper = mount(ToolIcon, { props: { tool } })
      expect(iconClasses(wrapper)).toContain(expectedClass)
    })
  }

  it('falls back to Wrench for an unknown tool name', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'NonExistentTool' } })
    expect(iconClasses(wrapper)).toContain('lucide-wrench')
  })

  it('falls back to Wrench when tool prop is empty', () => {
    const wrapper = mount(ToolIcon, { props: { tool: '' } })
    expect(iconClasses(wrapper)).toContain('lucide-wrench')
  })
})

describe('ToolIcon — status state drives icon + color', () => {
  it('status="running" renders Loader2 (the spinner icon) regardless of tool', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'Read', status: 'running' } })
    // Loader2 resolves to the loader-circle glyph in lucide 1.x.
    expect(iconClasses(wrapper)).toContain('lucide-loader-circle')
    // Class `tool-icon--running` applies the CSS spin animation.
    expect(iconClasses(wrapper)).toContain('tool-icon--running')
  })

  it('status="done" renders CheckCircle2 + green color class', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'Bash', status: 'done' } })
    // CheckCircle2 resolves to circle-check in lucide 1.x.
    expect(iconClasses(wrapper)).toContain('lucide-circle-check')
    expect(iconClasses(wrapper)).toContain('tool-icon--done')
  })

  it('status="error" renders XCircle + red color class', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'Write', status: 'error' } })
    // XCircle resolves to circle-x in lucide 1.x.
    expect(iconClasses(wrapper)).toContain('lucide-circle-x')
    expect(iconClasses(wrapper)).toContain('tool-icon--error')
  })

  it('status="idle" uses the mapped tool icon (not a status override)', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'Grep', status: 'idle' } })
    expect(iconClasses(wrapper)).toContain('lucide-search-code')
    expect(iconClasses(wrapper)).toContain('tool-icon--idle')
  })
})

describe('ToolIcon — rendering contract', () => {
  it('exposes data-testid and data-tool attributes for E2E selectors', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'Read' } })
    const svg = wrapper.find('[data-testid="tool-icon"]')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('data-tool')).toBe('Read')
    expect(svg.attributes('data-status')).toBe('idle')
  })

  it('size prop flows through to the rendered SVG', () => {
    const wrapper = mount(ToolIcon, { props: { tool: 'Read', size: 24 } })
    const svg = wrapper.find('svg')
    expect(svg.attributes('width')).toBe('24')
    expect(svg.attributes('height')).toBe('24')
  })

  it('does NOT render any emoji characters (regression guard for Lucide migration)', () => {
    // Render every mapped tool + fallback and verify no emoji leaks through.
    const tools = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent',
      'WebSearch', 'WebFetch', 'TodoWrite', 'Unknown']
    // Surrogate pair range — covers 📖 ✏️ 📝 ⚡ 🔍 📁 🤖 🌐 📋 🔧.
    const emojiRE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
    for (const tool of tools) {
      const wrapper = mount(ToolIcon, { props: { tool } })
      expect(wrapper.html()).not.toMatch(emojiRE)
    }
  })
})

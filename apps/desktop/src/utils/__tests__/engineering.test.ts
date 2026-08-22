import { describe, it, expect } from 'vitest'
import { formatEngineering, parseEngineering } from '../engineering'

describe('formatEngineering', () => {
  it('zero', () => {
    expect(formatEngineering(0)).toBe('0')
  })

  it('femto', () => {
    expect(formatEngineering(1e-15)).toBe('1f')
    expect(formatEngineering(2.5e-15)).toBe('2.5f')
  })

  it('pico', () => {
    expect(formatEngineering(1e-12)).toBe('1p')
    expect(formatEngineering(3.3e-12)).toBe('3.3p')
  })

  it('nano', () => {
    expect(formatEngineering(180e-9)).toBe('180n')
  })

  it('micro', () => {
    expect(formatEngineering(2.5e-6)).toBe('2.5u')
  })

  it('milli', () => {
    expect(formatEngineering(4.7e-3)).toBe('4.7m')
  })

  it('unit (no prefix)', () => {
    expect(formatEngineering(1)).toBe('1')
    expect(formatEngineering(3.14)).toBe('3.14')
  })

  it('kilo', () => {
    expect(formatEngineering(10000)).toBe('10k')
  })

  it('mega', () => {
    expect(formatEngineering(1e6)).toBe('1M')
  })

  it('giga', () => {
    expect(formatEngineering(2.4e9)).toBe('2.4G')
  })

  it('tera', () => {
    expect(formatEngineering(1e12)).toBe('1T')
  })

  it('negative value', () => {
    expect(formatEngineering(-500e-9)).toBe('-500n')
    expect(formatEngineering(-10e3)).toBe('-10k')
  })

  it('Infinity', () => {
    expect(formatEngineering(Infinity)).toBe('Infinity')
    expect(formatEngineering(-Infinity)).toBe('-Infinity')
  })

  it('NaN', () => {
    expect(formatEngineering(NaN)).toBe('NaN')
  })

  it('custom decimals', () => {
    const result = formatEngineering(1.23456e-6, 5)
    expect(result).toBe('1.23456u')
  })
})

describe('parseEngineering', () => {
  it('plain integer', () => {
    expect(parseEngineering('42')).toBe(42)
  })

  it('plain float', () => {
    expect(parseEngineering('3.14')).toBeCloseTo(3.14)
  })

  it('negative plain number', () => {
    expect(parseEngineering('-7')).toBe(-7)
  })

  it('scientific notation', () => {
    expect(parseEngineering('1.5e-9')).toBeCloseTo(1.5e-9)
    expect(parseEngineering('2.5e6')).toBeCloseTo(2.5e6)
  })

  it('femto', () => {
    expect(parseEngineering('1f')).toBeCloseTo(1e-15)
  })

  it('pico', () => {
    expect(parseEngineering('1p')).toBeCloseTo(1e-12)
    expect(parseEngineering('4.7p')).toBeCloseTo(4.7e-12)
  })

  it('nano', () => {
    expect(parseEngineering('180n')).toBeCloseTo(180e-9)
  })

  it('micro (u)', () => {
    expect(parseEngineering('2.5u')).toBeCloseTo(2.5e-6)
  })

  it('micro (mu symbol)', () => {
    expect(parseEngineering('2.5\u03BC')).toBeCloseTo(2.5e-6)
  })

  it('milli', () => {
    expect(parseEngineering('4.7m')).toBeCloseTo(4.7e-3)
  })

  it('kilo (lowercase)', () => {
    expect(parseEngineering('10k')).toBe(10000)
  })

  it('kilo (uppercase)', () => {
    expect(parseEngineering('10K')).toBe(10000)
  })

  it('mega', () => {
    expect(parseEngineering('1M')).toBe(1e6)
  })

  it('giga', () => {
    expect(parseEngineering('2.4G')).toBeCloseTo(2.4e9)
  })

  it('tera', () => {
    expect(parseEngineering('1T')).toBeCloseTo(1e12)
  })

  it('negative with prefix', () => {
    expect(parseEngineering('-3.3m')).toBeCloseTo(-0.0033)
    expect(parseEngineering('-10k')).toBeCloseTo(-10e3)
  })

  it('whitespace trimmed', () => {
    expect(parseEngineering('  10k  ')).toBe(10000)
  })

  it('empty string throws', () => {
    expect(() => parseEngineering('')).toThrow()
  })

  it('unknown prefix throws', () => {
    expect(() => parseEngineering('10z')).toThrow()
  })

  it('garbage input throws', () => {
    expect(() => parseEngineering('abc')).toThrow()
  })
})

describe('roundtrip consistency', () => {
  const testValues = [1e-15, 1e-12, 100e-9, 2.5e-6, 4.7e-3, 1, 10e3, 1e6, 2.4e9, 1e12]

  for (const val of testValues) {
    it(`format then parse: ${val}`, () => {
      const formatted = formatEngineering(val)
      const parsed = parseEngineering(formatted)
      expect(parsed).toBeCloseTo(val, 10)
    })
  }

  it('negative roundtrip', () => {
    const val = -500e-9
    const formatted = formatEngineering(val)
    const parsed = parseEngineering(formatted)
    expect(parsed).toBeCloseTo(val, 10)
  })
})

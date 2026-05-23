import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  EndpointsFileError,
  endpointsFilePath,
  loadEndpoints,
  plurToBzzExact,
  setDeclaredContextWindow,
  setDeclaredPrice,
  writeEndpoints,
  type InferenceEndpoint,
} from '../src/lib/endpoints'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't4t-endpoints-'))
})

afterEach(() => {
  rmSync(dir, {recursive: true, force: true})
  delete process.env.T4T_ENDPOINTS_FILE
})

describe('endpointsFilePath', () => {
  it('defaults to <dataDir>/endpoints.json', () => {
    expect(endpointsFilePath('/data')).toBe('/data/endpoints.json')
  })

  it('honours T4T_ENDPOINTS_FILE override', () => {
    process.env.T4T_ENDPOINTS_FILE = '/custom/path.json'
    expect(endpointsFilePath('/data')).toBe('/custom/path.json')
  })
})

describe('loadEndpoints', () => {
  it('parses a valid two-endpoint file', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {name: 'ollama', url: 'http://ollama:11434'},
        {name: 'openai', url: 'https://api.openai.com', apiKey: 'sk-test'},
      ]),
    )
    const eps = loadEndpoints(dir)
    expect(eps).toHaveLength(2)
    expect(eps[0]).toEqual({name: 'ollama', url: 'http://ollama:11434'})
    expect(eps[1]).toEqual({name: 'openai', url: 'https://api.openai.com', apiKey: 'sk-test'})
  })

  it('throws EndpointsFileError when the file is missing', () => {
    expect(() => loadEndpoints(dir)).toThrow(EndpointsFileError)
  })

  it('rejects an empty array', () => {
    writeFileSync(join(dir, 'endpoints.json'), '[]')
    expect(() => loadEndpoints(dir)).toThrow(EndpointsFileError)
  })

  it('rejects non-JSON contents', () => {
    writeFileSync(join(dir, 'endpoints.json'), 'not json')
    expect(() => loadEndpoints(dir)).toThrow(/not valid JSON/)
  })

  it('rejects a missing url field', () => {
    writeFileSync(join(dir, 'endpoints.json'), JSON.stringify([{name: 'x'}]))
    expect(() => loadEndpoints(dir)).toThrow(EndpointsFileError)
  })

  it('rejects a non-URL url value', () => {
    writeFileSync(join(dir, 'endpoints.json'), JSON.stringify([{name: 'x', url: 'not a url'}]))
    expect(() => loadEndpoints(dir)).toThrow(EndpointsFileError)
  })

  it('rejects names containing a slash', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([{name: 'open/ai', url: 'http://a:1'}]),
    )
    expect(() => loadEndpoints(dir)).toThrow(/must not contain/)
  })

  it('rejects duplicate names', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {name: 'x', url: 'http://a:1'},
        {name: 'x', url: 'http://b:2'},
      ]),
    )
    expect(() => loadEndpoints(dir)).toThrow(/duplicate endpoint name: x/)
  })

  it('follows T4T_ENDPOINTS_FILE when set', () => {
    const alt = join(dir, 'alt.json')
    writeFileSync(alt, JSON.stringify([{name: 'a', url: 'http://a:1'}]))
    process.env.T4T_ENDPOINTS_FILE = alt
    const eps = loadEndpoints('/ignored')
    expect(eps).toEqual([{name: 'a', url: 'http://a:1'}])
  })

  it('accepts a models block with BZZ decimal prices', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {
          name: 'ollama',
          url: 'http://ollama:11434',
          models: {
            llama3: {inputBzz: '0.3', outputBzz: '1.5'},
          },
        },
      ]),
    )
    const eps = loadEndpoints(dir)
    expect(eps[0]!.models).toEqual({llama3: {inputBzz: '0.3', outputBzz: '1.5'}})
  })

  it('rejects a price with more than 16 fractional digits', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {
          name: 'ollama',
          url: 'http://ollama:11434',
          models: {llama3: {inputBzz: '0.12345678901234567', outputBzz: '1'}},
        },
      ]),
    )
    expect(() => loadEndpoints(dir)).toThrow(/at most 16 fractional digits/)
  })

  it('accepts a models block with a contextWindow field', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {
          name: 'openai',
          url: 'https://api.openai.com',
          models: {
            'gpt-4o-mini': {inputBzz: '0.3', outputBzz: '1.5', contextWindow: 128000},
          },
        },
      ]),
    )
    const eps = loadEndpoints(dir)
    expect(eps[0]!.models!['gpt-4o-mini']).toEqual({
      inputBzz: '0.3',
      outputBzz: '1.5',
      contextWindow: 128000,
    })
  })

  it('rejects a negative contextWindow', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {
          name: 'openai',
          url: 'https://api.openai.com',
          models: {gpt: {inputBzz: '0', outputBzz: '0', contextWindow: -1}},
        },
      ]),
    )
    expect(() => loadEndpoints(dir)).toThrow(EndpointsFileError)
  })

  it('rejects a non-decimal price string', () => {
    writeFileSync(
      join(dir, 'endpoints.json'),
      JSON.stringify([
        {
          name: 'ollama',
          url: 'http://ollama:11434',
          models: {llama3: {inputBzz: 'free', outputBzz: '1.5'}},
        },
      ]),
    )
    expect(() => loadEndpoints(dir)).toThrow(EndpointsFileError)
  })
})

describe('writeEndpoints', () => {
  it('atomically writes JSON-pretty contents loadable by loadEndpoints', () => {
    const value = [
      {
        name: 'ollama',
        url: 'http://ollama:11434',
        models: {llama3: {inputBzz: '0.3', outputBzz: '1.5'}},
      },
    ]
    writeEndpoints(dir, value)
    const raw = readFileSync(join(dir, 'endpoints.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual(value)
    expect(loadEndpoints(dir)).toEqual(value)
  })
})

describe('setDeclaredPrice', () => {
  it('initializes the models block and reports a change', () => {
    const ep: InferenceEndpoint = {name: 'ollama', url: 'http://ollama:11434'}
    const changed = setDeclaredPrice(ep, 'llama3', 3_000_000_000_000_000n, 15_000_000_000_000_000n)
    expect(changed).toBe(true)
    expect(ep.models).toEqual({llama3: {inputBzz: '0.3', outputBzz: '1.5'}})
  })

  it('returns false when the existing entry already matches', () => {
    const ep: InferenceEndpoint = {
      name: 'ollama',
      url: 'http://ollama:11434',
      models: {llama3: {inputBzz: '0.3', outputBzz: '1.5'}},
    }
    const changed = setDeclaredPrice(ep, 'llama3', 3_000_000_000_000_000n, 15_000_000_000_000_000n)
    expect(changed).toBe(false)
  })

  it('overwrites a divergent existing entry', () => {
    const ep: InferenceEndpoint = {
      name: 'ollama',
      url: 'http://ollama:11434',
      models: {llama3: {inputBzz: '0.1', outputBzz: '0.2'}},
    }
    const changed = setDeclaredPrice(ep, 'llama3', 3_000_000_000_000_000n, 15_000_000_000_000_000n)
    expect(changed).toBe(true)
    expect(ep.models!.llama3).toEqual({inputBzz: '0.3', outputBzz: '1.5'})
  })

  it('preserves an existing contextWindow when only the price changes', () => {
    const ep: InferenceEndpoint = {
      name: 'openai',
      url: 'https://api.openai.com',
      models: {'gpt-4o-mini': {inputBzz: '0.1', outputBzz: '0.2', contextWindow: 128000}},
    }
    setDeclaredPrice(ep, 'gpt-4o-mini', 3_000_000_000_000_000n, 15_000_000_000_000_000n)
    expect(ep.models!['gpt-4o-mini']).toEqual({
      inputBzz: '0.3',
      outputBzz: '1.5',
      contextWindow: 128000,
    })
  })
})

describe('setDeclaredContextWindow', () => {
  it('initializes the entry with placeholder prices and reports a change', () => {
    const ep: InferenceEndpoint = {name: 'ollama', url: 'http://ollama:11434'}
    const changed = setDeclaredContextWindow(ep, 'llama3', 8192)
    expect(changed).toBe(true)
    expect(ep.models!.llama3).toEqual({inputBzz: '0', outputBzz: '0', contextWindow: 8192})
  })

  it('preserves prices when set on a model with existing prices', () => {
    const ep: InferenceEndpoint = {
      name: 'ollama',
      url: 'http://ollama:11434',
      models: {llama3: {inputBzz: '0.3', outputBzz: '1.5'}},
    }
    const changed = setDeclaredContextWindow(ep, 'llama3', 8192)
    expect(changed).toBe(true)
    expect(ep.models!.llama3).toEqual({inputBzz: '0.3', outputBzz: '1.5', contextWindow: 8192})
  })

  it('returns false when the existing contextWindow already matches', () => {
    const ep: InferenceEndpoint = {
      name: 'ollama',
      url: 'http://ollama:11434',
      models: {llama3: {inputBzz: '0.3', outputBzz: '1.5', contextWindow: 8192}},
    }
    expect(setDeclaredContextWindow(ep, 'llama3', 8192)).toBe(false)
  })

  it('clears the field when passed undefined or zero', () => {
    const ep: InferenceEndpoint = {
      name: 'ollama',
      url: 'http://ollama:11434',
      models: {llama3: {inputBzz: '0.3', outputBzz: '1.5', contextWindow: 8192}},
    }
    expect(setDeclaredContextWindow(ep, 'llama3', undefined)).toBe(true)
    expect(ep.models!.llama3).toEqual({inputBzz: '0.3', outputBzz: '1.5'})
    expect(setDeclaredContextWindow(ep, 'llama3', 0)).toBe(false)
  })
})

describe('plurToBzzExact', () => {
  it('round-trips through parseBzzToPlur without precision loss', async () => {
    const {parseBzzToPlur} = await import('../src/lib/admin-html')
    for (const s of ['0', '0.3', '1.5', '0.0000000000000001', '1234.5678', '12345678901234567']) {
      expect(plurToBzzExact(parseBzzToPlur(s))).toBe(s.replace(/^0+(\d)/, '$1'))
    }
  })

  it('renders integer PLUR values without a fractional part', () => {
    expect(plurToBzzExact(0n)).toBe('0')
    expect(plurToBzzExact(10n ** 16n)).toBe('1')
    expect(plurToBzzExact(3n * 10n ** 15n)).toBe('0.3')
  })
})

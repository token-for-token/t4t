import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EndpointsFileError, endpointsFilePath, loadEndpoints} from '../src/lib/endpoints'

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
})

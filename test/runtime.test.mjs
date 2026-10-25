// Versión de Node con parches de seguridad vigentes (aviso de octubre 2026).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPatchedNode } from '../src/utils/runtime.js';

describe('Versión de Node parchada', () => {
  it('acepta las versiones con el parche y las posteriores de la misma línea', () => {
    for (const v of ['v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.30.0', 'v26.12.1']) assert.equal(isPatchedNode(v), true, v);
  });
  it('rechaza las anteriores al parche y las líneas sin soporte', () => {
    for (const v of ['v22.23.3', 'v24.22.0', 'v26.12.0', 'v25.8.2', 'v20.19.0', 'v18.20.0']) assert.equal(isPatchedNode(v), false, v);
  });
});

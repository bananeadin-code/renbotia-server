// Formato de las respuestas de la IA según el canal.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatForChannel } from '../src/utils/chatFormat.js';

describe('Formato por canal', () => {
  const md = '## Horarios\n**Lunes:** 9 a 18 h\n* Corte: $150\nMás en [precios](https://renbotia.com/precios)\n---';

  it('WhatsApp: negrita con un asterisco, viñetas con guion, enlaces legibles', () => {
    assert.equal(
      formatForChannel(md, 'whatsapp'),
      '*Horarios*\n*Lunes:* 9 a 18 h\n- Corte: $150\nMás en precios: https://renbotia.com/precios'
    );
  });

  it('Web, Messenger e Instagram: texto plano sin asteriscos', () => {
    for (const ch of ['web', 'facebook', 'instagram', 'site']) {
      assert.equal(formatForChannel(md, ch), 'Horarios\nLunes: 9 a 18 h\n- Corte: $150\nMás en precios: https://renbotia.com/precios');
    }
    assert.equal(formatForChannel('Promo *2x1* hoy', 'web'), 'Promo 2x1 hoy');
  });

  it('no toca operaciones ni texto normal', () => {
    assert.equal(formatForChannel('Son 5*3 = 15 y 2*4.', 'web'), 'Son 5*3 = 15 y 2*4.');
    assert.equal(formatForChannel('Hola, ¿en qué te ayudo?', 'whatsapp'), 'Hola, ¿en qué te ayudo?');
    assert.equal(formatForChannel('', 'web'), '');
  });
});

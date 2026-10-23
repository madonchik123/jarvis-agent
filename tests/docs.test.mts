// Document toolkit: create → read back → edit, for DOCX and PPTX (pure Node, no Electron needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDocx } from '../src/main/docs/docx.ts'
import { buildPptx } from '../src/main/docs/pptx.ts'
import { readDocument } from '../src/main/docs/read.ts'
import { editDocx, editPptx } from '../src/main/docs/edit.ts'
import { COURSEWORK, DECK } from './fixtures/docs-specs.mts'

const dir = mkdtempSync(join(tmpdir(), 'jarvis-docs-'))

test('docx: GOST coursework builds and reads back with headings, lists and table', async () => {
  const p = join(dir, 'kurs.docx')
  writeFileSync(p, await buildDocx(COURSEWORK))
  const t = await readDocument(p)
  assert.match(t, /^DOCX · \d+ paragraphs · 1 tables/)
  assert.match(t, /# ВВЕДЕНИЕ/)
  assert.match(t, /## 1\.1 Свёрточные сети/)
  assert.match(t, /• сегментация опухолей/)
  assert.match(t, /\| ResNet-50 \| 92 % \| 25 млн \|/)
  assert.match(t, /Таблица 1 – Сравнение архитектур/)
  assert.match(t, /КУРСОВАЯ РАБОТА/)
})

test('docx: edits keep indexes of the original file and formatting', async () => {
  const p = join(dir, 'kurs.docx')
  const before = await readDocument(p)
  const idx = (re: RegExp) => +new RegExp(String.raw`\[#(\d+)\] [^\n]*` + re.source).exec(before)![1]
  const intro = idx(/Цель работы/)
  const concl = idx(/Нейросети уже сегодня/)
  const out = join(dir, 'kurs-edited.docx')
  const r = await editDocx(
    p,
    [
      { op: 'set_paragraph', index: intro, text: 'Цель работы — оценить эффективность нейросетей в диагностике.' },
      { op: 'insert_after', index: intro, blocks: [{ type: 'heading', level: 2, text: 'Задачи исследования' }, { type: 'bullet', text: 'собрать данные' }] },
      { op: 'delete', index: concl },
      { op: 'replace_text', find: 'быстрым ростом', replace: 'стремительным ростом' }
    ],
    out,
    join(dir, 'bak')
  )
  assert.match(r, /set #\d+; inserted 2 after #\d+; deleted #\d+; replaced "быстрым ростом" ×1/)
  const t = await readDocument(out)
  assert.match(t, /оценить эффективность/)
  assert.doesNotMatch(t, /проанализировать применение/)
  assert.match(t, /## Задачи исследования/)
  assert.match(t, /• собрать данные/)
  assert.doesNotMatch(t, /Нейросети уже сегодня/)
  assert.match(t, /стремительным ростом/)
})

test('docx: replace_text across differently formatted runs', async () => {
  const p = join(dir, 'kurs.docx')
  const out = join(dir, 'kurs-span.docx')
  // "**быстрым ростом** объёма" is split into a bold run and a normal run
  await editDocx(p, [{ op: 'replace_text', find: 'ростом объёма', replace: 'увеличением объёма' }], out, join(dir, 'bak'))
  assert.match(await readDocument(out), /быстрым увеличением объёма медицинских данных/)
})

test('pptx: every layout builds and reads back', async () => {
  const p = join(dir, 'deck.pptx')
  writeFileSync(p, await buildPptx(DECK))
  const t = await readDocument(p)
  assert.match(t, /^PPTX · 9 slides/)
  assert.match(t, /Jarvis: голосовой ИИ-агент/)
  assert.match(t, /Десятки окон и вкладок/)
  assert.match(t, /notes: Начать с боли пользователя\./)
  assert.match(t, /\| Управляет ПК \| да \| нет \|/)
  const out = join(dir, 'deck2.pptx')
  await editPptx(p, [{ op: 'replace_text', find: 'Рутинные клики', replace: 'Бесконечные клики' }], out, join(dir, 'bak'))
  assert.match(await readDocument(out), /Бесконечные клики каждый день/)
})

// 1×1 PNG, enough to place a picture
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

test('pptx: diagram slides and credited images', async () => {
  const img = join(dir, 'chart.png')
  writeFileSync(img, PNG)
  const p = join(dir, 'deck-visual.pptx')
  writeFileSync(
    p,
    await buildPptx({
      title: 'Visual',
      theme: 'clean',
      slides: [
        { layout: 'diagram', title: 'Как это работает', image: img, fit: 'contain', caption: 'Схема процесса' },
        { layout: 'bullets', title: 'Фото', bullets: ['один', 'два'], image: img, credit: 'Автор, CC BY-SA 4.0, Wikimedia Commons' },
        { layout: 'image', title: 'Во весь экран', image: img, credit: 'Public domain' }
      ]
    })
  )
  const t = await readDocument(p)
  assert.match(t, /^PPTX · 3 slides/)
  assert.match(t, /Схема процесса/)
  assert.match(t, /CC BY-SA 4\.0, Wikimedia Commons/)
  assert.equal(t.match(/\[image\]/g)?.length, 3)
})

test('docx: figures get numbered captions and source lines', async () => {
  const img = join(dir, 'chart.png')
  writeFileSync(img, PNG)
  const p = join(dir, 'fig.docx')
  writeFileSync(p, await buildDocx({ title: 'Отчёт', template: 'modern', blocks: [{ type: 'image', path: img, caption: 'Солнечная станция', credit: 'Автор, CC BY 4.0' }] }))
  const t = await readDocument(p)
  assert.match(t, /\[image\]/)
  assert.match(t, /Рисунок 1 – Солнечная станция/)
  assert.match(t, /Источник: Автор, CC BY 4\.0/)
})

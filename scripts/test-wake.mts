import { stripWake } from '../src/shared/textmatch.ts'
const al = ['джарвис', 'jarvis']
for (const t of ['джарвис открой ютуб', 'жарвис привет', 'эй джарвис', 'Jarvis, open chrome', 'джар вис включи свет', 'ярвис', 'привет мир', 'дарвин открой', 'чарльз открой', 'сервис открой', 'открой джарвис']) {
  const r = stripWake(t, al)
  console.log(JSON.stringify(t), '=>', r.hit?.alias, r.hit?.score.toFixed(2), JSON.stringify(r.command))
}

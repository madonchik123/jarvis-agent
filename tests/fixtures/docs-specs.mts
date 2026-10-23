// Sample document specs shared by tests/docs.test.mts and manual render checks.
import type { DocSpec, DeckSpec } from '../../src/main/docs/spec.ts'

export const COURSEWORK: DocSpec = {
  title: 'Применение нейросетей в медицине',
  template: 'gost',
  toc: true,
  title_page: {
    organization: 'Министерство науки и высшего образования РФ\nМосковский технический университет',
    faculty: 'Факультет информационных технологий',
    department: 'Кафедра прикладной информатики',
    work_type: 'Курсовая работа',
    discipline: 'Интеллектуальные системы',
    author: 'Иванов И. И.',
    group: 'ИТ-21',
    supervisor: 'доц. Петров П. П.',
    city: 'Москва',
    year: '2026'
  },
  blocks: [
    { type: 'heading', level: 1, text: 'ВВЕДЕНИЕ' },
    { type: 'paragraph', text: 'Актуальность темы обусловлена **быстрым ростом** объёма медицинских данных и потребностью в *точной* диагностике.' },
    { type: 'paragraph', text: 'Цель работы — проанализировать применение нейросетей для анализа медицинских изображений.' },
    { type: 'heading', level: 1, text: '1 Теоретические основы' },
    { type: 'heading', level: 2, text: '1.1 Свёрточные сети' },
    { type: 'paragraph', text: 'Свёрточные нейронные сети извлекают признаки изображения послойно.' },
    { type: 'bullets', items: ['классификация снимков', 'сегментация опухолей', 'детекция патологий'] },
    { type: 'table', caption: 'Сравнение архитектур', header: ['Модель', 'Точность', 'Параметры'], rows: [['ResNet-50', '92 %', '25 млн'], ['U-Net', '89 %', '31 млн']] },
    { type: 'heading', level: 1, text: 'ЗАКЛЮЧЕНИЕ' },
    { type: 'paragraph', text: 'Нейросети уже сегодня помогают врачам ставить диагноз быстрее.' },
    { type: 'heading', level: 1, text: 'СПИСОК ИСПОЛЬЗОВАННЫХ ИСТОЧНИКОВ' },
    { type: 'references', items: ['Гудфеллоу Я., Бенджио И., Курвилль А. Глубокое обучение. — М.: ДМК Пресс, 2018. — 652 с.'] }
  ]
}

export const DECK: DeckSpec = {
  title: 'Jarvis: голосовой ИИ-агент',
  subtitle: 'Как управлять ПК голосом',
  author: 'Команда Jarvis',
  theme: 'midnight',
  slides: [
    { layout: 'title' },
    { layout: 'section', title: 'Проблема' },
    { layout: 'bullets', title: 'Что мешает сегодня', bullets: ['Десятки окон и вкладок', 'Рутинные клики каждый день', 'Документы делаются часами'], notes: 'Начать с боли пользователя.' },
    { layout: 'two_column', title: 'До и после', left: { title: 'Руками', bullets: ['30 минут на отчёт', 'Ошибки копирования'] }, right: { title: 'С Джарвисом', bullets: ['1 фраза', 'Готовый DOCX'] } },
    { layout: 'stats', title: 'Цифры', stats: [{ value: '27', label: 'инструментов' }, { value: '0 ₽', label: 'стоимость' }, { value: '2', label: 'языка' }] },
    { layout: 'timeline', title: 'Как это работает', steps: [{ title: 'Слушает', text: 'локальное распознавание' }, { title: 'Думает', text: 'агент opencode' }, { title: 'Делает', text: 'окна, файлы, документы' }] },
    { layout: 'table', title: 'Сравнение', header: ['', 'Jarvis', 'Обычный ассистент'], rows: [['Управляет ПК', 'да', 'нет'], ['Документы', 'да', 'частично']] },
    { layout: 'quote', quote: 'Иногда нужно бежать, прежде чем научишься ходить.', author: 'Тони Старк' },
    { layout: 'closing', subtitle: 'github.com/madonchik123/jarvis-agent' }
  ]
}

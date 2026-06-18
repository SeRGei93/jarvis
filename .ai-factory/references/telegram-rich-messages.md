# Telegram Rich Messages — справочник по форматированию (Bot API 10.1)

Источник: <https://core.telegram.org/bots/api#rich-message-formatting-options>
(секция «Rich Message Formatting Options»; зарыта глубоко в общей странице API).

## Что это и как jarvis это использует

jarvis отправляет ответы как **rich message** через `sendRichMessage` (финал) и
`sendRichMessageDraft` (стриминговый превью-черновик). Тело — это
`InputRichMessage`, у которого ровно одно из полей:

- `markdown` — GFM-надмножество + произвольный HTML;
- `html` — HTML-стиль.

В коде ответ модели уходит как `{ markdown: <текст модели> }`
(`backend/src/telegram/format.ts` → `stream.ts`). **Следствие:** любой rich-синтаксис
из этого файла, который модель напишет в ответе, отрендерится у пользователя.
Чтобы скиллы давали богатые ответы (картинки/слайдеры/таблицы) — достаточно, чтобы
модель эмитила нужный синтаксис (см. «Как разнообразить ответы скиллов» в конце) и
имела реальные URL медиа из результатов тулов.

## Лимиты

- ≤ 32768 UTF-8 символов на сообщение.
- ≤ 500 блоков (включая вложенные, пункты списков, строки таблиц, details).
- ≤ 16 уровней вложенности.
- ≤ 50 медиа-вложений (фото + видео + аудио).
- Медиа — только как **отдельный блок**, только **HTTP/HTTPS** URL.
  Тип определяется по MIME и URL. Для медиа бот должен иметь право слать медиа в чат.

---

## Rich Markdown style (поле `markdown`)

### Inline
```
**bold**            __bold__
*italic*            _italic_
~~strikethrough~~
`inline code`
==marked==          (подсветка)
||spoiler||
$x^2 + y^2$         (inline LaTeX)
[текст](https://t.me/)            [почта](mailto:user@example.com)
[телефон](tel:+123456789)         [меншн](tg://user?id=123456789)
![](tg://emoji?id=5368324170671202286)         (кастом-эмодзи)
![22:45 tomorrow](tg://time?unix=1647531900&format=wDT)   (дата/время)
```
URL, e-mail, @username, #hashtag, $CASHTAG, /command, телефоны, номера карт
определяются автоматически (можно отключить `skip_entity_detection`).

### Блоки
```
# H1  ## H2  ### H3  #### H4  ##### H5  ###### H6

Параграф.

```python
print('код с подсветкой языка')
```            ← (тройные бэктики + язык)

---                         ← разделитель (hr)

- пункт      * пункт      + пункт          (маркированный)
1. пункт     2. пункт                       (нумерованный)
- [ ] невыполненная задача
- [x] выполненная задача

> Цитата, строка 1
> Цитата, строка 2

| Header 1 | Header 2 |
|:---------|:--------:|
| left     | center   |          (ячейки — только inline; 2–4 колонки на мобиле)

Текст со сноской[^id1].
[^id1]: Определение сноски.

$$E = mc^2$$                ← блок-формула
```math
E = mc^2
```
```

### Медиа (только отдельным блоком, HTTP/HTTPS)
```
![](https://example.com/photo.jpg)            фото
![](https://example.com/video.mp4)            видео
![](https://example.com/audio.mp3)            аудио
![](https://example.com/audio.ogg)            голосовое
![](https://example.com/animation.gif)        анимация

![](https://example.com/photo.jpg "Подпись")  с подписью (caption — это title после URL)
```

### Коллаж и слайдшоу (несколько медиа в одном блоке)
Внутри `<tg-collage>` / `<tg-slideshow>` markdown **парсится** (нужны пустые строки):
```
<tg-collage>

![](https://example.com/photo.jpg)
![](https://example.com/video.mp4)

</tg-collage>

<tg-slideshow>

![](https://example.com/1.jpg)
![](https://example.com/2.jpg)

</tg-slideshow>
```

### Сворачиваемый блок (details) — markdown внутри парсится
```
<details open><summary>Заголовок с **жирным**</summary>

### Подзаголовок
- пункт с _курсивом_
- пункт со <tg-spoiler>спойлером</tg-spoiler>

</details>
```
Без `open` — свёрнут по умолчанию. Нужны пустые строки вокруг содержимого.

### Что не имеет markdown-синтаксиса — пишется HTML-тегами
`<u>` / `<ins>` подчёркнутый · `<sub>` / `<sup>` · `<a name="anchor"></a>` якорь ·
`<aside>Pull quote<cite>Автор</cite></aside>` выносная цитата ·
`<tg-map lat="41.9" long="12.5" zoom="14"/>` карта.

> Внутри блочных HTML-тегов markdown **не** парсится — кроме `<details>`,
> `<tg-collage>` и `<tg-slideshow>`. Rich Markdown совместим с GFM и может содержать
> произвольный HTML из списка ниже.

---

## Rich HTML style (поле `html`)

Поддерживаемые теги (то, чего нет в markdown — особенно медиа с подписями/спойлером):

```
Inline: <b>/<strong>, <i>/<em>, <u>/<ins>, <s>/<strike>/<del>, <code>,
        <mark>, <sub>, <sup>, <tg-spoiler>spoiler</tg-spoiler>,
        <tg-emoji emoji-id="…"></tg-emoji>, <tg-time unix="…" format="wDT">…</tg-time>,
        <tg-math>x^2</tg-math>, <a href="…">…</a>, <tg-reference name="…">…</tg-reference>

Блоки: <h1>…<h6>, <p>, <pre>, <pre><code class="language-python">…</code></pre>,
       <footer>, <hr/>, <ul><li>…</li></ul>, <ol start="3" type="a" reversed>…</ol>,
       чек-листы <li><input type="checkbox" checked>…</li>,
       <blockquote>…<cite>Автор</cite></blockquote>, <aside>Pull quote<cite>…</cite></aside>

Медиа (отдельным блоком):
  <img src="…"/>  <video src="…"></video>  <audio src="…"></audio>
  <figure><img src="…" tg-spoiler/><figcaption>Подпись<cite>Кредит</cite></figcaption></figure>
  <figure><video src="…" tg-spoiler></video><figcaption>…</figcaption></figure>
  <tg-map lat="…" long="…" zoom="…"/>
  <tg-collage><img src="…"/><video src="…"/><figcaption>Подпись коллажа</figcaption></tg-collage>
  <tg-slideshow><img src="…"/><video src="…"/><figcaption>Подпись слайдшоу</figcaption></tg-slideshow>

Таблица: <table bordered striped><caption>…</caption>
           <tr><th>…</th></tr>
           <tr><td colspan="2" rowspan="2" align="left" valign="top">…</td></tr></table>

Прочее: <details open><summary>Title</summary>Content</details>
        <tg-math-block>E = mc^2</tg-math-block>
        <a name="chapter-1"></a> якорь, <a href="#chapter-1">ссылка в документе</a>
```

Заметки по HTML:
- Поддерживаются только перечисленные теги.
- Числовые HTML-entity — все; именованные — только: `&lt; &gt; &amp; &quot; &apos;
  &nbsp; &hellip; &mdash; &ndash; &lsquo; &rsquo; &ldquo; &rdquo;`.
- `<img>`/`<video>`/`<audio>` — только отдельными блоками, только HTTP/HTTPS.
- В `<figcaption>` кредит подписи задаётся `<cite>`.
- Тело `<details>` — полноценный rich-контент; `open` — развёрнут по умолчанию.

---

## Thinking-блок (RichBlockThinking) — ТОЛЬКО в draft

```
<tg-thinking>Думаю…</tg-thinking>
```
Валиден **только в `sendRichMessageDraft`** (блок «бот думает» во время стриминга),
**не** в финальном `sendRichMessage`. Для рекомендуемых кастом-эмодзи: <https://t.me/addemoji/AIActions>.
В jarvis используется для admin-дебага рассуждений в стриме; в финале рассуждения
кладутся в свёрнутый `<details>` (см. `backend/src/telegram/stream.ts`).

---

## Как разнообразить ответы скиллов

1. **Механизм уже есть.** Текст ответа модели уходит как rich markdown — значит
   `![](url)`, `<tg-collage>`, `<tg-slideshow>`, `<figure>`, таблицы, `<details>`
   отрендерятся, если модель их напишет.
2. **Нужны реальные URL медиа** из результатов тулов (листинги kufar/av.by/relax,
   афиша, web-поиск картинок). Тул должен возвращать image/video URL, а инструкция
   скилла — разрешать/предлагать их показывать.
3. **Где включать:** общий `backend/prompts/FORMAT.md` (добавить раздел про медиа:
   фото/коллаж/слайдшоу для листингов и галерей) и/или `instructions` конкретных
   скиллов (`SkillService`). Сейчас FORMAT.md медиа **не** упоминает.
4. **Безопасность (CLAUDE.md):** медиа-URL из fetched web content — untrusted.
   Telegram их зафетчит на своей стороне; давай модели использовать только URL из
   доверенных результатов тулов, не «сырые» ссылки из произвольного веб-контента.
   Медиа — только HTTP/HTTPS; у бота должно быть право слать медиа в чат.

Идеи под разные скиллы:
- **Листинги (kufar, av.by, недвижимость, афиша):** заголовок-ссылка + цена в списке,
  главная фотка `![](url)` или `<tg-collage>` на 2–4 фото объекта.
- **Галерея/подборка:** `<tg-slideshow>` (листается свайпом).
- **Погода/курсы/расписание:** таблицы (уже есть) + `==highlight==` на ключевом значении.
- **Длинные детали:** `<details>` чтобы свернуть второстепенное.
- **Места:** `<tg-map lat long zoom/>`.

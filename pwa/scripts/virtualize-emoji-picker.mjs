import { readFile, writeFile } from 'node:fs/promises';

// The pinned library renders every cell despite content-visibility:auto. Keep its
// controls/events, but window both category and search grids before Angular creates cells.
// Apply to both partial-compiled template copies; fail closed on upstream changes.
const packageFile = new URL('../node_modules/@nicematic/emoji-picker/package.json', import.meta.url);
const { version, module: modulePath } = JSON.parse(await readFile(packageFile, 'utf8'));
if (version !== '2.3.6') throw new Error('Review emoji grid windowing before upgrading @nicematic/emoji-picker.');
const moduleFile = new URL(modulePath, packageFile);
let source = await readFile(moduleFile, 'utf8');
const marker = '// chahua: windowed emoji grid';
if (!source.includes(marker)) {
  function replace(before, after, expected = 1) {
    const count = source.split(before).length - 1;
    if (count !== expected) throw new Error(`Expected ${expected} emoji grid matches, found ${count}: ${before}`);
    source = source.replaceAll(before, after);
  }
  replace(
    'class EmojiGridComponent {',
    `class EmojiGridComponent {
${marker}
    viewportTop = signal(0);
    viewportWidth = signal(0);
    viewportObserver;
    scrollFrame;
    windowColumns = computed(() => this.viewportWidth()
        ? Math.max(1, Math.floor((this.viewportWidth() - 8) / this.cellSize()))
        : this.columns());
    windowFor(emojis, offset) {
        const columns = this.windowColumns();
        const size = this.cellSize();
        const rows = Math.ceil(emojis.length / columns);
        const first = Math.min(rows, Math.max(0, Math.floor((this.viewportTop() - offset) / size) - 2));
        const end = Math.min(rows, Math.max(first, Math.ceil((this.viewportTop() + this.height() - offset) / size) + 2));
        return { before: first * size, after: (rows - end) * size, emojis: emojis.slice(first * columns, end * columns) };
    }
    searchWindow = computed(() => this.windowFor(this.emojis(), 4));
    visibleGroups = computed(() => {
        let offset = 0;
        return this.groups().map(group => {
            const window = this.windowFor(group.emojis, offset + 28);
            offset += 28 + Math.ceil(group.emojis.length / this.windowColumns()) * this.cellSize();
            return { category: group.category, ...window };
        });
    });
`,
  );
  replace(
    '        const el = this.scrollContainerRef.nativeElement;\n        this.scrollHandler = () => {',
    `        const el = this.scrollContainerRef.nativeElement;
        this.viewportWidth.set(el.clientWidth);
        this.viewportObserver = new ResizeObserver(() => {
            if (el.clientWidth > 0) this.viewportWidth.set(el.clientWidth);
        });
        this.viewportObserver.observe(el);
        this.scrollHandler = () => {
            this.viewportTop.set(el.scrollTop);`,
  );
  replace(
    "        this.scrollContainerRef?.nativeElement.removeEventListener('scroll', this.scrollHandler);",
    `        cancelAnimationFrame(this.scrollFrame);
        this.viewportObserver?.disconnect();
        this.scrollContainerRef?.nativeElement.removeEventListener('scroll', this.scrollHandler);`,
  );
  replace(
    '        this.searchQuery.set(query);',
    `        if (this.grid) {
            this.grid.scrollContainerRef.nativeElement.scrollTop = 0;
            this.grid.viewportTop.set(0);
        }
        this.searchQuery.set(query);`,
  );
  replace(
    "'repeat(auto-fill, minmax(' + cellSize() + 'px, 1fr))'",
    "'repeat(' + windowColumns() + ', minmax(0, 1fr))'",
    4,
  );
  replace(
    '@for (group of groups(); track group.category.id)',
    '@for (group of visibleGroups(); track group.category.id)',
    2,
  );
  replace(
    '[displayChar]="group.displayChars[i]"',
    '[displayChar]="dataService.getEmojiWithSkinTone(emoji, skinTone())"',
    2,
  );
  replace(
    'style="scrollbar-width:none;-webkit-overflow-scrolling:touch;"',
    'style="scrollbar-width:none;-webkit-overflow-scrolling:touch;overflow-anchor:none;"',
    2,
  );
  replace(
    '<div class="grid px-1"',
    '<div [style.height.px]="group.before"></div>\n            <div class="grid px-1"',
    2,
  );
  replace(
    '            </div>\n          </div>\n        }\n        <div class="h-3">',
    '            </div>\n            <div [style.height.px]="group.after"></div>\n          </div>\n        }\n        <div class="h-3">',
    2,
  );
  replace(
    '<div class="grid px-1 py-1"',
    '<div style="padding-top:4px;padding-bottom:4px">\n        <div [style.height.px]="searchWindow().before"></div>\n        <div class="grid px-1"',
    2,
  );
  replace('@for (emoji of emojis(); track emoji.char)', '@for (emoji of searchWindow().emojis; track emoji.char)', 2);
  replace(
    '        </div>\n      } @else {\n        @for (group',
    '        </div>\n        <div [style.height.px]="searchWindow().after"></div>\n        </div>\n      } @else {\n        @for (group',
    2,
  );
  replace(
    '            requestAnimationFrame(() => {\n                this.ticking = false;',
    '            this.scrollFrame = requestAnimationFrame(() => {\n                this.ticking = false;',
  );
  await writeFile(moduleFile, source);
}

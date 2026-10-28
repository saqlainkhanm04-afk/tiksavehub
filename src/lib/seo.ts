// Centralized SEO metadata guards.
//
// Every page is allowed to pass its own human-written title/description, but
// the rendered <title> and meta description must always be:
//   - one separator style: a hyphen (`-`)
//   - <= 60 characters for titles
//   - 120-160 characters for descriptions
//
// Keeping the enforcement here means dynamic pages (blog posts, compare
// pages, future routes) can never drift outside the audit targets.

export const TITLE_MAX = 60;
export const DESC_MIN = 120;
export const DESC_MAX = 160;

export type DescriptionKind = 'tool' | 'legal' | 'contact' | 'blog' | 'error' | 'compare';

const BRAND_SUFFIX = /(?:\s+-\s+TikSaveHub(?:\s+Blog)?)+$/i;
const ENDS_WITH_PUNCT = /[.!?。！？]$/;

const PERIOD: Record<string, string> = {
  en: '.',
  es: '.',
  de: '.',
  fr: '.',
  it: '.',
  pt: '.',
  ja: '。',
  ko: '.',
};

const JOINER: Record<string, string> = {
  ja: '',
};

// Category-aware sentences are used only when a page description is below the
// 120-character minimum. They add genuinely new information (browser support,
// response time, policy scope) instead of repeating "free, fast, no sign-up".
const SUFFIXES: Record<string, Record<DescriptionKind, string[]>> = {
  en: {
    tool: [
      'No app install needed.',
      'Runs directly in your browser, with no app to install.',
      'Works directly in your browser on iPhone, Android, and PC, with no app to install.',
    ],
    legal: [
      'Read the full policy for details.',
      'Read the full policy to see exactly how TikSaveHub handles this.',
      'Read the full policy for complete details on how TikSaveHub handles data, cookies, and copyright requests.',
    ],
    contact: [
      'We usually reply within two business days.',
      'Send us a message and we usually reply within two business days.',
      'Send us a message with the page URL and we usually reply within two business days.',
    ],
    blog: [
      'Browse the latest guides.',
      'Browse step-by-step guides and downloader tips for every platform.',
      'Browse step-by-step guides, troubleshooting tips, and downloader comparisons for every supported platform.',
    ],
    error: [
      'Head back to the homepage to try again.',
      'Return to the homepage or open the main downloader to try again.',
      'Return to the homepage or open the main downloader to try again, or check the URL for typos.',
    ],
    compare: [
      'Both tools are free.',
      'Both tools are free, need no account, and run in any browser.',
      'Both tools are free, need no account, and run in any browser on iPhone, Android, and PC.',
    ],
  },
  es: {
    tool: [
      'No hace falta instalar ninguna app.',
      'Funciona directamente en el navegador, sin instalar ninguna app.',
      'Funciona en el navegador en iPhone, Android y PC, sin instalar ninguna app.',
    ],
    legal: [
      'Lee la política completa para ver todos los detalles.',
      'Lee la política completa para conocer todos los detalles sobre datos y cookies.',
      'Lee la política completa para conocer todos los detalles sobre datos, cookies y derechos de autor.',
    ],
    contact: [
      'Solemos responder en un plazo de dos días hábiles.',
      'Envíanos un mensaje y te responderemos en dos días hábiles.',
      'Envíanos un mensaje con la URL de la página y te responderemos en dos días hábiles.',
    ],
    blog: [
      'Lee las últimas guías.',
      'Lee guías paso a paso y consejos de descarga para cada plataforma.',
      'Lee guías paso a paso, soluciones de problemas y comparativas de descargadores.',
    ],
    error: [
      'Vuelve a la página de inicio e inténtalo de nuevo.',
      'Vuelve a la página de inicio o abre el descargador principal e inténtalo de nuevo.',
      'Vuelve a la página de inicio o abre el descargador principal e inténtalo de nuevo, o revisa la URL.',
    ],
    compare: [
      'Ambas herramientas son gratis.',
      'Ambas herramientas son gratis y no necesitan cuenta.',
      'Ambas herramientas son gratis, no necesitan cuenta y funcionan en cualquier navegador.',
    ],
  },
  de: {
    tool: [
      'Keine App-Installation nötig.',
      'Läuft direkt im Browser, ohne App-Installation.',
      'Funktioniert direkt im Browser auf iPhone, Android und PC, ohne App-Installation.',
    ],
    legal: [
      'Lies die vollständige Richtlinie für alle Details.',
      'Lies die vollständige Richtlinie, um alle Details zur Datenverarbeitung zu erfahren.',
      'Lies die vollständige Richtlinie, um alle Details zu Daten, Cookies und Urheberrechtsanfragen zu erfahren.',
    ],
    contact: [
      'Wir antworten in der Regel innerhalb von zwei Werktagen.',
      'Schreib uns und wir antworten in der Regel innerhalb von zwei Werktagen.',
      'Schreib uns mit der Seiten-URL und wir antworten in der Regel innerhalb von zwei Werktagen.',
    ],
    blog: [
      'Lies die neuesten Anleitungen.',
      'Lies Schritt-für-Schritt-Anleitungen und Downloader-Tipps für jede Plattform.',
      'Lies Schritt-für-Schritt-Anleitungen, Problemlösungen und Downloader-Vergleiche für jede Plattform.',
    ],
    error: [
      'Kehre zur Startseite zurück und versuche es erneut.',
      'Kehre zur Startseite zurück oder öffne den Haupt-Downloader und versuche es erneut.',
      'Kehre zur Startseite zurück oder öffne den Haupt-Downloader und versuche es erneut, oder prüfe die URL.',
    ],
    compare: [
      'Beide Tools sind kostenlos.',
      'Beide Tools sind kostenlos und brauchen kein Konto.',
      'Beide Tools sind kostenlos, brauchen kein Konto und laufen in jedem Browser.',
    ],
  },
  fr: {
    tool: [
      'Aucune application à installer.',
      'Fonctionne directement dans le navigateur, sans application à installer.',
      'Fonctionne dans le navigateur sur iPhone, Android et PC, sans application à installer.',
    ],
    legal: [
      'Lisez la politique complète pour tous les détails.',
      'Lisez la politique complète pour connaître tous les détails sur les données et les cookies.',
      "Lisez la politique complète pour connaître tous les détails sur les données, les cookies et les droits d'auteur.",
    ],
    contact: [
      'Nous répondons généralement sous deux jours ouvrés.',
      'Envoyez-nous un message et nous répondons sous deux jours ouvrés.',
      "Envoyez-nous un message avec l'URL de la page et nous répondons sous deux jours ouvrés.",
    ],
    blog: [
      'Lisez les derniers guides.',
      'Lisez des guides pas à pas et des conseils de téléchargement pour chaque plateforme.',
      'Lisez des guides pas à pas, des solutions aux problèmes et des comparatifs de téléchargeurs.',
    ],
    error: [
      "Revenez à l'accueil et réessayez.",
      "Revenez à l'accueil ou ouvrez le téléchargeur principal et réessayez.",
      "Revenez à l'accueil ou ouvrez le téléchargeur principal et réessayez, ou vérifiez l'URL.",
    ],
    compare: [
      'Les deux outils sont gratuits.',
      'Les deux outils sont gratuits et sans compte.',
      'Les deux outils sont gratuits, sans compte et fonctionnent dans tous les navigateurs.',
    ],
  },
  it: {
    tool: [
      'Nessuna app da installare.',
      'Funziona direttamente nel browser, senza installare app.',
      'Funziona nel browser su iPhone, Android e PC, senza installare app.',
    ],
    legal: [
      'Leggi la policy completa per tutti i dettagli.',
      'Leggi la policy completa per conoscere tutti i dettagli su dati e cookie.',
      'Leggi la policy completa per conoscere tutti i dettagli su dati, cookie e copyright.',
    ],
    contact: [
      'Di solito rispondiamo entro due giorni lavorativi.',
      'Scrivici e di solito rispondiamo entro due giorni lavorativi.',
      "Scrivici con l'URL della pagina e di solito rispondiamo entro due giorni lavorativi.",
    ],
    blog: [
      'Leggi le ultime guide.',
      'Leggi guide passo passo e consigli sui downloader per ogni piattaforma.',
      'Leggi guide passo passo, soluzioni ai problemi e confronti tra downloader.',
    ],
    error: [
      'Torna alla pagina iniziale e riprova.',
      'Torna alla pagina iniziale o apri il downloader principale e riprova.',
      'Torna alla pagina iniziale o apri il downloader principale e riprova, oppure controlla la URL.',
    ],
    compare: [
      'Entrambi gli strumenti sono gratuiti.',
      'Entrambi gli strumenti sono gratuiti e senza account.',
      'Entrambi gli strumenti sono gratuiti, senza account e funzionano in ogni browser.',
    ],
  },
  pt: {
    tool: [
      'Não precisa instalar nenhum app.',
      'Funciona direto no navegador, sem instalar nenhum app.',
      'Funciona no navegador em iPhone, Android e PC, sem instalar nenhum app.',
    ],
    legal: [
      'Leia a política completa para ver todos os detalhes.',
      'Leia a política completa para saber todos os detalhes sobre dados e cookies.',
      'Leia a política completa para saber todos os detalhes sobre dados, cookies e direitos autorais.',
    ],
    contact: [
      'Normalmente respondemos em até dois dias úteis.',
      'Envie uma mensagem e responderemos em até dois dias úteis.',
      'Envie uma mensagem com a URL da página e responderemos em até dois dias úteis.',
    ],
    blog: [
      'Leia os guias mais recentes.',
      'Leia guias passo a passo e dicas de download para cada plataforma.',
      'Leia guias passo a passo, soluções de problemas e comparações de downloaders.',
    ],
    error: [
      'Volte à página inicial e tente novamente.',
      'Volte à página inicial ou abra o downloader principal e tente novamente.',
      'Volte à página inicial ou abra o downloader principal e tente novamente, ou confira a URL.',
    ],
    compare: [
      'As duas ferramentas são grátis.',
      'As duas ferramentas são grátis e não exigem conta.',
      'As duas ferramentas são grátis, não exigem conta e funcionam em qualquer navegador.',
    ],
  },
  ja: {
    tool: [
      '無料で使えます。',
      'スマホでもPCでも使えます。',
      'リンクを貼るだけで保存できます。',
      'TikSaveHubは無料のブラウザツールで、会員登録やアプリのインストールは不要です。すべての機能を無料で利用できます。',
    ],
    legal: [
      '詳細はポリシー全文をご確認ください。',
      'データの取り扱いとCookieの使用について説明しています。',
      '著作権侵害の報告方法と削除依頼の流れもまとめています。',
      'TikSaveHubにおけるデータの取り扱い、Cookieの使用、著作権侵害の報告方法をまとめています。',
    ],
    contact: [
      '通常2営業日以内に返信します。',
      'ページのURLを添えてお問い合わせください。',
      'お困りの内容を詳しく書いていただけると助かります。',
      'ページのURLとお困りの内容を添えてお気軽にお問い合わせください。',
    ],
    blog: [
      '最新のガイドをチェックしましょう。',
      '各プラットフォームの手順ガイドを掲載しています。',
      'トラブル解決のヒントも合わせてご覧ください。',
      '各プラットフォームの手順ガイド、トラブル解決、ダウンローダー比較をチェックしましょう。',
    ],
    error: [
      'ホームページに戻ってもう一度お試しください。',
      'メインのダウンローダーを開いてもう一度お試しください。',
      'URLに誤りがないかもご確認ください。',
      'ホームページに戻るか、メインのダウンローダーを開いてもう一度お試しください。URLもご確認ください。',
    ],
    compare: [
      'どちらも無料で使えます。',
      'どちらもアカウント不要で使えます。',
      'どちらもスマホとPCのブラウザで使えます。',
      'どちらも無料でアカウント不要、スマホとPCのどのブラウザでも使えます。',
    ],
  },
  ko: {
    tool: [
      '앱 설치가 필요 없습니다.',
      '스마트폰과 PC에서 무료로 사용할 수 있습니다.',
      '동영상 링크를 붙여넣으면 바로 저장됩니다.',
      'TikSaveHub는 설치 없이 브라우저에서 바로 사용하는 도구이며, 회원가입도 필요 없습니다.',
    ],
    legal: [
      '자세한 내용은 전체 정책을 확인하세요.',
      '데이터 처리와 쿠키 사용 방법을 안내합니다.',
      '저작권 침해 신고 절차도 확인할 수 있습니다.',
      'TikSaveHub의 데이터 처리, 쿠키 사용, 저작권 침해 신고 방법을 모두 안내합니다.',
    ],
    contact: [
      '보통 영업일 기준 2일 이내에 답변합니다.',
      '페이지 URL과 함께 문의해 주세요.',
      '문의 내용을 자세히 적어주시면 도움이 됩니다.',
      '페이지 URL과 문의 내용을 함께 보내주시면 보통 영업일 기준 2일 이내에 답변합니다.',
    ],
    blog: [
      '최신 가이드를 확인하세요.',
      '플랫폼별 단계별 가이드를 제공합니다.',
      '문제 해결 팁도 함께 확인하세요.',
      '플랫폼별 단계별 가이드, 문제 해결 팁, 다운로더 비교를 모두 확인하세요.',
    ],
    error: [
      '홈페이지로 돌아가 다시 시도하세요.',
      '메인 다운로더를 열어 다시 시도하세요.',
      'URL에 오타가 없는지도 확인하세요.',
      '홈페이지로 돌아가거나 메인 다운로더를 열어 다시 시도하고 URL도 확인하세요.',
    ],
    compare: [
      '두 도구 모두 무료입니다.',
      '두 도구 모두 계정이 필요 없습니다.',
      '두 도구 모두 스마트폰과 PC에서 사용할 수 있습니다.',
      '두 도구 모두 무료이고 계정 없이 스마트폰과 PC의 모든 브라우저에서 사용할 수 있습니다.',
    ],
  },
};

const TRAILING_CONNECTORS =
  /(?:\s+(?:&|and|or|und|oder|y|e|o|et|ou|de|da|do|of|for|with|to|from|the|a|an|la|le|les|el|los|las|en|con|per|su|il|lo|gli|un|una|uno|mit|für))$/i;

function stripDangling(value: string): string {
  return value.replace(/[\s\-–—|:;,]+$/g, '').trim();
}

function cleanCut(value: string): string {
  let out = stripDangling(value);
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = stripDangling(out.replace(TRAILING_CONNECTORS, ''));
  }
  return out;
}

/** Normalize every title separator to a single hyphen style. */
export function normalizeTitleSeparators(value: string): string {
  return value
    .replace(/\s*[—–|]\s*/g, ' - ')
    .replace(/\s*--\s*/g, ' - ')
    .replace(/\s*:\s+/g, ' - ')
    .replace(/\.\s+(?=[A-Z0-9À-ÖØ-Þ])/g, ' - ')
    .replace(/(?:\s+-\s+){2,}/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function shortenTitle(value: string): string {
  const parts = value.split(' - ');
  while (parts.length > 1) {
    parts.pop();
    const candidate = cleanCut(parts.join(' - '));
    if (candidate.length <= TITLE_MAX) return candidate;
  }

  let cut = value.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= 30) cut = cut.slice(0, lastSpace);
  cut = cleanCut(cut);
  return cut || cleanCut(value.slice(0, TITLE_MAX));
}

/**
 * Return a title with hyphen separators and a hard 60-character ceiling.
 * Long titles first lose the brand prefix/suffix and then any trailing
 * descriptor segment, so the primary keyword survives instead of a blind
 * character cut.
 */
export function seoTitle(raw: string): string {
  if (!raw) return raw;
  const title = normalizeTitleSeparators(raw);
  if (title.length <= TITLE_MAX) return title;

  const leadingBrand = title.match(/^TikSaveHub\s+-\s+/i);
  if (leadingBrand) {
    const body = title.slice(leadingBrand[0].length);
    const branded = `TikSaveHub - ${body}`;
    if (branded.length <= TITLE_MAX) return branded;
    return shortenTitle(body);
  }

  const withoutBrand = cleanCut(title.replace(BRAND_SUFFIX, ''));
  if (!withoutBrand) return shortenTitle(title);

  if (withoutBrand.length <= TITLE_MAX) {
    const branded = `${withoutBrand} - TikSaveHub`;
    return branded.length <= TITLE_MAX ? branded : withoutBrand;
  }

  return shortenTitle(withoutBrand);
}

function truncateDescription(value: string, lang: string): string {
  if (value.length <= DESC_MAX) return value;
  const slice = value.slice(0, DESC_MAX);

  let sentenceCut = -1;
  for (const mark of ['. ', '! ', '? ', '。', '！', '？']) {
    const idx = slice.lastIndexOf(mark);
    const end = idx + mark.length;
    if (end >= DESC_MIN && end <= DESC_MAX) sentenceCut = Math.max(sentenceCut, end);
  }
  if (sentenceCut > 0) return slice.slice(0, sentenceCut).trim();

  // No complete sentence fits; fall back to a clause boundary before cutting
  // a word in half.
  let clauseCut = -1;
  for (const mark of [', ', '; ', ' — ', ' – ']) {
    const idx = slice.lastIndexOf(mark);
    if (idx >= DESC_MIN) clauseCut = Math.max(clauseCut, idx);
  }
  if (clauseCut > 0) {
    return `${slice.slice(0, clauseCut).trim()}${PERIOD[lang] ?? '.'}`;
  }

  let wordCut = slice;
  const space = wordCut.lastIndexOf(' ');
  if (space >= DESC_MIN) wordCut = wordCut.slice(0, space);
  wordCut = wordCut.replace(/[\s,;:\-–—]+$/g, '').trim();
  if (!ENDS_WITH_PUNCT.test(wordCut) && wordCut.length < DESC_MAX) {
    wordCut += PERIOD[lang] ?? '.';
  }
  return wordCut.length > DESC_MAX ? wordCut.slice(0, DESC_MAX) : wordCut;
}

/**
 * Normalize a description length to the 120-160 character window. Long copy
 * is cut at a sentence or clause boundary; short copy gains category-aware,
 * language-matched sentences.
 */
export function seoDescription(
  raw: string,
  lang = 'en',
  kind: DescriptionKind = 'tool'
): string {
  if (!raw) return raw;
  let desc = raw.replace(/\s+/g, ' ').trim();
  const language = SUFFIXES[lang] ?? SUFFIXES.en;
  const suffixes = language[kind] ?? language.tool;

  if (desc.length > DESC_MAX) return truncateDescription(desc, lang);
  if (desc.length >= DESC_MIN) return desc;

  if (!ENDS_WITH_PUNCT.test(desc)) desc += PERIOD[lang] ?? '.';

  const used = new Set<string>();
  for (let pass = 0; pass < 4 && desc.length < DESC_MIN; pass++) {
    const gap = DESC_MIN - desc.length;
    const room = DESC_MAX - desc.length;
    const available = suffixes.filter((suffix) => !used.has(suffix));
    if (available.length === 0) break;

    const exact = available
      .filter((suffix) => suffix.length >= gap && suffix.length <= room)
      .sort((a, b) => a.length - b.length);
    let addition = exact[0];

    if (!addition) {
      const under = available
        .filter((suffix) => suffix.length <= room)
        .sort((a, b) => b.length - a.length);
      addition = under[0] ?? [...available].sort((a, b) => a.length - b.length)[0];
    }
    if (!addition) break;

    used.add(addition);
    desc += `${JOINER[lang] ?? ' '}${addition}`;
    if (desc.length > DESC_MAX) return truncateDescription(desc, lang);
  }

  return desc.length > DESC_MAX ? truncateDescription(desc, lang) : desc;
}

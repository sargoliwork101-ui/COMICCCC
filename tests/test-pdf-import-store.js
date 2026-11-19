// Tests for the IndexedDB bridge between the preview tab and the PDF converter tab.
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

const PdfImportStore = require('../extension/src/core/pdf-import-store.js');

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log('PASS:', name);
  else { failures++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  // putSession + getSession round-trip
  {
    await PdfImportStore.putSession({ token: 'sess-1', name: 'comic.pdf', totalPages: 3 });
    const session = await PdfImportStore.getSession('sess-1');
    check('putSession/getSession round-trips the session', session && session.token === 'sess-1' && session.name === 'comic.pdf' && session.totalPages === 3, session);
    check('putSession stamps updatedAt', typeof session.updatedAt === 'number' && session.updatedAt > 0, session);
    const missing = await PdfImportStore.getSession('no-such-token');
    check('getSession returns undefined for an unknown token', missing === undefined, missing);
  }

  // putPage + getPages returns pages sorted by pageNumber
  {
    await PdfImportStore.putPage({ token: 'sess-1', pageNumber: 3, dataUrl: 'data:3' });
    await PdfImportStore.putPage({ token: 'sess-1', pageNumber: 1, dataUrl: 'data:1' });
    await PdfImportStore.putPage({ token: 'sess-1', pageNumber: 2, dataUrl: 'data:2' });
    await PdfImportStore.putPage({ token: 'sess-2', pageNumber: 1, dataUrl: 'other' });
    const pages = await PdfImportStore.getPages('sess-1');
    check('getPages returns only the requested session pages sorted by pageNumber',
      pages.length === 3 && pages[0].pageNumber === 1 && pages[1].pageNumber === 2 && pages[2].pageNumber === 3 &&
      pages.every((page) => page.token === 'sess-1'), pages);
    check('putPage derives the composite id from token and pageNumber', pages[0].id === 'sess-1:1', pages[0]);
    const empty = await PdfImportStore.getPages('no-pages');
    check('getPages returns an empty array for an unknown token', Array.isArray(empty) && empty.length === 0, empty);
  }

  // putPage overwrites the same pageNumber
  {
    await PdfImportStore.putPage({ token: 'sess-1', pageNumber: 2, dataUrl: 'data:2-new' });
    const pages = await PdfImportStore.getPages('sess-1');
    check('putPage overwrites an existing pageNumber instead of duplicating it',
      pages.length === 3 && pages.find((page) => page.pageNumber === 2).dataUrl === 'data:2-new', pages);
  }

  // deleteSession removes the session and only its own pages
  {
    await PdfImportStore.deleteSession('sess-1');
    const session = await PdfImportStore.getSession('sess-1');
    const pages = await PdfImportStore.getPages('sess-1');
    const otherPages = await PdfImportStore.getPages('sess-2');
    check('deleteSession removes the session and its pages but keeps other sessions',
      session === undefined && pages.length === 0 && otherPages.length === 1, { session, pages, otherPages });
  }

  // pruneStaleSessions removes old sessions and their orphan pages, keeps fresh ones
  {
    const now = Date.now();
    await PdfImportStore.putSession({ token: 'old', finishedAt: now - 7 * 60 * 60 * 1000 });
    await PdfImportStore.putSession({ token: 'fresh', finishedAt: now });
    await PdfImportStore.putSession({ token: 'no-stamp' });
    await PdfImportStore.putPage({ token: 'old', pageNumber: 1, dataUrl: 'old-page' });
    await PdfImportStore.putPage({ token: 'fresh', pageNumber: 1, dataUrl: 'fresh-page' });
    await PdfImportStore.putPage({ token: 'ghost', pageNumber: 1, dataUrl: 'orphan-page' });
    const removed = await PdfImportStore.pruneStaleSessions();
    const oldSession = await PdfImportStore.getSession('old');
    const freshSession = await PdfImportStore.getSession('fresh');
    const noStampSession = await PdfImportStore.getSession('no-stamp');
    const oldPages = await PdfImportStore.getPages('old');
    const freshPages = await PdfImportStore.getPages('fresh');
    const ghostPages = await PdfImportStore.getPages('ghost');
    check('pruneStaleSessions removes sessions older than the cutoff and their pages',
      removed === 1 && oldSession === undefined && oldPages.length === 0,
      { removed, oldSession, oldPages });
    check('pruneStaleSessions keeps sessions with a recent updatedAt even without finishedAt',
      noStampSession && noStampSession.token === 'no-stamp', noStampSession);
    check('pruneStaleSessions keeps fresh sessions and removes orphan pages without a session',
      freshSession && freshSession.token === 'fresh' && freshPages.length === 1 && ghostPages.length === 0,
      { freshSession, freshPages, ghostPages });
  }

  // pruneStaleSessions honors keepToken
  {
    const now = Date.now();
    await PdfImportStore.putSession({ token: 'kept', finishedAt: now - 7 * 60 * 60 * 1000 });
    await PdfImportStore.putPage({ token: 'kept', pageNumber: 1, dataUrl: 'kept-page' });
    const removed = await PdfImportStore.pruneStaleSessions(6 * 60 * 60 * 1000, 'kept');
    const kept = await PdfImportStore.getSession('kept');
    const keptPages = await PdfImportStore.getPages('kept');
    check('pruneStaleSessions keeps the keepToken session and its pages even when stale',
      removed === 0 && kept && kept.token === 'kept' && keptPages.length === 1, { removed, kept, keptPages });
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PDF IMPORT STORE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });

import assert from 'node:assert/strict';
import test from 'node:test';
import type {WorkbookState} from '../types';
import type {WorkerRequest, WorkerResponse} from './dataWorker';
import {AppStore} from './store';
import {normalizeRecordsToSheet, parseCsvText} from './tabular';
import {DataWorkerClient, type WorkerLike} from './workerClient';

class MockWorker implements WorkerLike {
  public posted: Array<{msg: WorkerRequest; transfer?: Transferable[]}> = [];
  public terminated = false;
  private messageListeners: Array<(ev: MessageEvent<WorkerResponse>) => void> =
    [];
  private errorListeners: Array<(ev: ErrorEvent) => void> = [];

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({msg: message as WorkerRequest, transfer});
  }

  addEventListener(type: 'message' | 'error', listener: any): void {
    if (type === 'message') {
      this.messageListeners.push(listener);
    } else if (type === 'error') {
      this.errorListeners.push(listener);
    }
  }

  emitMessage(data: WorkerResponse): void {
    for (const fn of this.messageListeners) {
      fn({data} as MessageEvent<WorkerResponse>);
    }
  }

  emitError(message: string): void {
    for (const fn of this.errorListeners) {
      fn({message} as ErrorEvent);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function makeLargeWorkbook(rowCount = 3000): WorkbookState {
  const columns = ['Item', 'Amount', 'Category'];
  const records: string[][] = new Array(rowCount + 1);
  records[0] = columns;
  for (let i = 0; i < rowCount; i++) {
    records[i + 1] = [
      `Row-${String(i).padStart(4, '0')}`,
      String((rowCount - i) * 10),
      i % 2 === 0 ? 'Alpha' : 'Beta',
    ];
  }
  const sheet = normalizeRecordsToSheet(records, 'Data', 'sheet-large');
  return {
    fileName: 'large.csv',
    fileFormat: 'csv',
    sheets: [sheet],
    activeSheetIndex: 0,
  };
}

function makeNamedWorkbook(fileName: string, csv: string): WorkbookState {
  const sheet = parseCsvText(csv, fileName);
  return {
    fileName,
    fileFormat: 'csv',
    sheets: [sheet],
    activeSheetIndex: 0,
  };
}

function makeDummyFile(name: string, content = 'a,b\n1,2'): File {
  return new File([content], name, {type: 'text/csv'});
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('workerClient: superseded parseFile promises settle cleanly as null and stale parsed response does not clobber newer version', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});

  const file1 = makeDummyFile('first.csv');
  const file2 = makeDummyFile('second.csv');

  const p1 = client.parseFile(file1, 10);
  const p2 = client.parseFile(file2, 11);

  assert.equal(mockWorker.posted.length, 2);
  const req1 = mockWorker.posted[0].msg;
  const req2 = mockWorker.posted[1].msg;
  assert.equal(req1.type, 'parse-file');
  assert.equal(req2.type, 'parse-file');

  // Even before worker responds, p1 must settle immediately as null (not hang)
  const r1 = await Promise.race([
    p1,
    new Promise((res) => setTimeout(() => res('HUNG'), 25)),
  ]);
  assert.equal(r1, null);

  // Worker responds out of order: req2 succeeds first, then late req1 sends parsed & error
  const wb2 = makeNamedWorkbook('second.csv', 'X,Y\n9,10');
  const wb1 = makeNamedWorkbook('first.csv', 'A,B\n1,2');

  mockWorker.emitMessage({
    type: 'parsed',
    requestId: req2.requestId,
    workbook: wb2,
    cachedVersion: 11,
  });
  mockWorker.emitMessage({
    type: 'parsed',
    requestId: req1.requestId,
    workbook: wb1,
    cachedVersion: 10,
  });

  const r2 = await p2;
  assert.equal(r2?.fileName, 'second.csv');

  // Verify syncedSheetVersion wasn't clobbered back to 10 by late req1:
  // filterAndSort with sheetVersion 11 should NOT need to re-upload the sheet
  const largeSheet = makeLargeWorkbook(2600).sheets[0];
  const filterPromise = client.filterAndSort({
    sheet: largeSheet,
    sheetVersion: 11,
    searchQuery: 'Row-0001',
    sort: {colIndex: null, direction: null},
  });
  const filterReq = mockWorker.posted[2].msg;
  assert.equal(filterReq.type, 'filter-sort');
  assert.equal(filterReq.sheet, undefined);

  const buf = Int32Array.from([1]).buffer;
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: filterReq.requestId,
    sheetVersion: 11,
    indicesBuffer: buf,
  });
  const filterRes = await filterPromise;
  assert.deepEqual(Array.from(filterRes ?? []), [1]);

  client.dispose();
});

test('workerClient: concurrent filterAndSort requests settle every earlier promise as null and ignore stale worker replies', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});
  const sheet = makeLargeWorkbook(2600).sheets[0];

  const p1 = client.filterAndSort({
    sheet,
    sheetVersion: 2,
    searchQuery: 'Row-0',
    sort: {colIndex: null, direction: null},
  });
  const p2 = client.filterAndSort({
    sheet,
    sheetVersion: 2,
    searchQuery: 'Row-1',
    sort: {colIndex: 1, direction: 'asc'},
  });
  const p3 = client.filterAndSort({
    sheet,
    sheetVersion: 2,
    searchQuery: 'Row-2',
    sort: {colIndex: 1, direction: 'desc'},
  });

  // p1 and p2 must settle to null promptly without waiting for worker replies
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, null);
  assert.equal(r2, null);

  assert.equal(mockWorker.posted.length, 3);
  const id1 = (mockWorker.posted[0].msg as Extract<WorkerRequest, {type: 'filter-sort'}>).requestId;
  const id2 = (mockWorker.posted[1].msg as Extract<WorkerRequest, {type: 'filter-sort'}>).requestId;
  const id3 = (mockWorker.posted[2].msg as Extract<WorkerRequest, {type: 'filter-sort'}>).requestId;

  // Worker answers stale id2 and id1 before id3
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: id2,
    sheetVersion: 2,
    indicesBuffer: Int32Array.from([20, 21]).buffer,
  });
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: id1,
    sheetVersion: 2,
    indicesBuffer: Int32Array.from([10]).buffer,
  });
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: id3,
    sheetVersion: 2,
    indicesBuffer: Int32Array.from([30, 31, 32]).buffer,
  });

  const r3 = await p3;
  assert.deepEqual(Array.from(r3 ?? []), [30, 31, 32]);

  // Also verify switching from in-flight worker filter to sync unfiltered clear settles earlier promise
  const p4 = client.filterAndSort({
    sheet,
    sheetVersion: 2,
    searchQuery: 'Alpha',
    sort: {colIndex: null, direction: null},
  });
  const p5 = client.filterAndSort({
    sheet,
    sheetVersion: 2,
    searchQuery: '',
    sort: {colIndex: null, direction: null},
  });
  const [r4, r5] = await Promise.all([p4, p5]);
  assert.equal(r4, null);
  assert.equal(r5?.length, 2600);

  client.dispose();
});

test('AppStore: concurrent loadFile ignores stale progress, stale workbook, and stale errors', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});
  const store = new AppStore(undefined, client);

  const load1 = store.loadFile(makeDummyFile('stale.csv'));
  const load2 = store.loadFile(makeDummyFile('winner.csv'));

  const req1 = mockWorker.posted[0].msg as Extract<WorkerRequest, {type: 'parse-file'}>;
  const req2 = mockWorker.posted[1].msg as Extract<WorkerRequest, {type: 'parse-file'}>;

  // Stale progress from req1 must not overwrite loading message for winner.csv
  mockWorker.emitMessage({
    type: 'progress',
    requestId: req1.requestId,
    progress: 0.9,
    message: 'Stale progress message',
  });
  assert.equal(store.loading.active, true);
  assert.match(store.loading.message, /winner\.csv/);

  // Stale parse-error from req1 must not surface error banner or stop loading
  mockWorker.emitMessage({
    type: 'parse-error',
    requestId: req1.requestId,
    error: 'Corrupt first file',
  });
  assert.equal(store.errorMessage, null);
  assert.equal(store.loading.active, true);

  // req2 finishes
  mockWorker.emitMessage({
    type: 'parsed',
    requestId: req2.requestId,
    workbook: makeNamedWorkbook('winner.csv', 'K,V\nwin,100'),
    cachedVersion: req2.initialSheetVersion,
  });

  await Promise.all([load1, load2]);
  assert.equal(store.workbook.fileName, 'winner.csv');
  assert.equal(store.errorMessage, null);
  assert.equal(store.loading.active, false);

  store.dispose();
});

test('AppStore: rapid debounced search coalesces into one worker query and cancels when cleared or sorted', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});
  const store = new AppStore(makeLargeWorkbook(3000), client);

  // Clear initial compute-stats post from constructor
  mockWorker.posted.length = 0;

  store.setSearchQueryDebounced('Row', 25);
  store.setSearchQueryDebounced('Row-0', 25);
  store.setSearchQueryDebounced('Row-001', 25);

  assert.equal(
    mockWorker.posted.filter((p) => p.msg.type === 'filter-sort').length,
    0
  );

  await new Promise((res) => setTimeout(res, 50));

  const filterPosts = mockWorker.posted.filter(
    (p) => p.msg.type === 'filter-sort'
  );
  assert.equal(filterPosts.length, 1);
  const postedReq = filterPosts[0].msg as Extract<
    WorkerRequest,
    {type: 'filter-sort'}
  >;
  assert.equal(postedReq.searchQuery, 'Row-001');

  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: postedReq.requestId,
    sheetVersion: postedReq.sheetVersion,
    indicesBuffer: Int32Array.from([10, 11, 12]).buffer,
  });
  await flushMicrotasks();
  assert.deepEqual(Array.from(store.visibleRowIndices), [10, 11, 12]);

  // Now queue another debounced search, then immediately clearSearch() before timer fires
  mockWorker.posted.length = 0;
  store.setSearchQueryDebounced('Alpha', 25);
  store.clearSearch();

  await new Promise((res) => setTimeout(res, 50));
  assert.equal(store.searchQuery, '');
  assert.equal(store.visibleRowIndices.length, 3000);
  assert.equal(
    mockWorker.posted.filter((p) => p.msg.type === 'filter-sort').length,
    0
  );

  store.dispose();
});

test('AppStore: cell edit while sorted (sorting while editing) triggers requery and rejects stale worker responses', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});
  const store = new AppStore(makeLargeWorkbook(2600), client);
  mockWorker.posted.length = 0;

  // Start async sort on col 1 ascending
  store.toggleSortColumn(1);
  const sortReq = mockWorker.posted.find((p) => p.msg.type === 'filter-sort')!
    .msg as Extract<WorkerRequest, {type: 'filter-sort'}>;

  // Before sortReq resolves, user commits an edit to cell (0, 1)
  store.commitCellEdit(0, 1, '9999999');
  assert.equal(store.activeSheet.rows[0][1], '9999999');
  assert.equal(store.lastCellPatch?.needsRequery, true);

  const requeryPosts = mockWorker.posted.filter(
    (p) => p.msg.type === 'filter-sort'
  );
  assert.equal(requeryPosts.length, 2);
  const editRequeryReq = requeryPosts[1].msg as Extract<
    WorkerRequest,
    {type: 'filter-sort'}
  >;

  // Stale sortReq responds first with old version -> MUST be discarded
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: sortReq.requestId,
    sheetVersion: sortReq.sheetVersion,
    indicesBuffer: Int32Array.from([2599, 2598, 0]).buffer,
  });
  await flushMicrotasks();
  assert.equal(store.visibleRowIndices.length, 2600);

  // New editRequeryReq responds -> MUST apply cleanly
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: editRequeryReq.requestId,
    sheetVersion: editRequeryReq.sheetVersion,
    indicesBuffer: Int32Array.from([2599, 2598, 1, 0]).buffer,
  });
  await flushMicrotasks();
  assert.deepEqual(Array.from(store.visibleRowIndices), [2599, 2598, 1, 0]);

  store.dispose();
});

test('AppStore: deleteRow, deleteColumn, and undo maintain filter/sort index bounds while async worker filter is pending', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});
  const store = new AppStore(makeLargeWorkbook(2600), client);
  mockWorker.posted.length = 0;

  // Complete an initial filter yielding [2, 5, 10]
  store.toggleSortColumn(1);
  const reqA = mockWorker.posted.find((p) => p.msg.type === 'filter-sort')!
    .msg as Extract<WorkerRequest, {type: 'filter-sort'}>;
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: reqA.requestId,
    sheetVersion: reqA.sheetVersion,
    indicesBuffer: Int32Array.from([2, 5, 10]).buffer,
  });
  await flushMicrotasks();
  assert.deepEqual(Array.from(store.visibleRowIndices), [2, 5, 10]);

  // Start another async sort (reqB) that stays pending
  mockWorker.posted.length = 0;
  store.toggleSortColumn(1); // desc
  const reqB = mockWorker.posted.find((p) => p.msg.type === 'filter-sort')!
    .msg as Extract<WorkerRequest, {type: 'filter-sort'}>;

  // Delete row 5 while reqB is pending
  store.deleteRow(5);
  assert.equal(store.activeSheet.rows.length, 2599);
  // Immediately aligned: 5 removed, 10 shifted to 9
  assert.deepEqual(Array.from(store.visibleRowIndices), [2, 9]);

  // Stale reqB arrives late -> discarded, does not reintroduce invalid row 5 or stale order
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: reqB.requestId,
    sheetVersion: reqB.sheetVersion,
    indicesBuffer: Int32Array.from([10, 5, 2]).buffer,
  });
  await flushMicrotasks();
  assert.deepEqual(Array.from(store.visibleRowIndices), [2, 9]);

  // Complete reqC emitted by deleteRow
  const reqC = mockWorker.posted
    .filter((p) => p.msg.type === 'filter-sort')
    .at(-1)!.msg as Extract<WorkerRequest, {type: 'filter-sort'}>;
  mockWorker.emitMessage({
    type: 'filter-sort-result',
    requestId: reqC.requestId,
    sheetVersion: reqC.sheetVersion,
    indicesBuffer: Int32Array.from([9, 2]).buffer,
  });
  await flushMicrotasks();
  assert.deepEqual(Array.from(store.visibleRowIndices), [9, 2]);

  // Undo deleteRow while deleting column test: ensure sort shifts/resets cleanly
  store.deleteColumn(0); // col 0 < sort.colIndex (1) -> shifts sort.colIndex to 0
  assert.equal(store.sort.colIndex, 0);
  store.deleteColumn(0); // deleting sorted column resets sort
  assert.deepEqual(store.sort, {colIndex: null, direction: null});
  assert.equal(store.visibleRowIndices.length, 2599);

  // Put active filter on a smaller remaining sheet and undo deleteRow to verify clampVisibleRowIndices
  store.undo(); // restores col 0
  store.undo(); // restores col 0
  store.toggleSortColumn(1);
  // Simulate undo while sorted
  store.undo(); // undoes deleteRow(5) -> back to 2600 rows
  for (let i = 0; i < store.visibleRowIndices.length; i++) {
    assert.ok(store.visibleRowIndices[i] >= 0);
    assert.ok(store.visibleRowIndices[i] < store.activeSheet.rows.length);
  }

  store.dispose();
});

test('AppStore: repeated cell selection is a no-op and column stats use per-column cache + async worker for large datasets', async () => {
  const mockWorker = new MockWorker();
  const client = new DataWorkerClient({createWorker: () => mockWorker});
  const store = new AppStore(makeLargeWorkbook(2600), client);

  let selectionEmits = 0;
  let statsEmits = 0;
  store.subscribe(['selection'], () => selectionEmits++);
  store.subscribe(['stats'], () => statsEmits++);

  // Finish initial col 0 stats request from constructor
  const initStatsReq = mockWorker.posted.find(
    (p) => p.msg.type === 'compute-stats'
  )!.msg as Extract<WorkerRequest, {type: 'compute-stats'}>;
  mockWorker.emitMessage({
    type: 'stats-result',
    requestId: initStatsReq.requestId,
    sheetVersion: initStatsReq.sheetVersion,
    colIndex: 0,
    filterKey: initStatsReq.filterKey,
    stats: {
      count: 2600,
      numericCount: 0,
      sum: 0,
      avg: 0,
      min: 0,
      max: 0,
      nonEmptyCount: 2600,
      uniqueCount: 2600,
    },
  });
  await flushMicrotasks();
  assert.equal(store.activeColumnStats.colIndex, 0);
  assert.equal(store.activeColumnStats.loading, false);
  statsEmits = 0;

  // Select (0, 0) once to set highlightedRowIndex = 0, then verify repeating it emits nothing
  store.selectCell({rowIndex: 0, colIndex: 0});
  selectionEmits = 0;
  statsEmits = 0;
  store.selectCell({rowIndex: 0, colIndex: 0});
  assert.equal(selectionEmits, 0);
  assert.equal(statsEmits, 0);

  // Selecting (5, 0) in same cached column updates selection without stats recompute
  mockWorker.posted.length = 0;
  store.selectCell({rowIndex: 5, colIndex: 0});
  assert.equal(selectionEmits, 1);
  assert.equal(statsEmits, 0);
  assert.equal(
    mockWorker.posted.filter((p) => p.msg.type === 'compute-stats').length,
    0
  );

  // Selecting cold col 1 marks loading synchronously & delegates stats to worker
  store.selectCell({rowIndex: 5, colIndex: 1});
  assert.equal(selectionEmits, 2);
  assert.equal(statsEmits, 1);
  assert.equal(store.activeColumnStats.colIndex, 1);
  assert.equal(store.activeColumnStats.loading, true);

  // Clicking another row in cold col 1 while loading does NOT restart identical worker request
  store.selectCell({rowIndex: 6, colIndex: 1});
  assert.equal(selectionEmits, 3);
  assert.equal(
    mockWorker.posted.filter((p) => p.msg.type === 'compute-stats').length,
    1
  );

  const col1Req = mockWorker.posted.find((p) => p.msg.type === 'compute-stats')!
    .msg as Extract<WorkerRequest, {type: 'compute-stats'}>;
  mockWorker.emitMessage({
    type: 'stats-result',
    requestId: col1Req.requestId,
    sheetVersion: col1Req.sheetVersion,
    colIndex: 1,
    filterKey: col1Req.filterKey,
    stats: {
      count: 2600,
      numericCount: 2600,
      sum: 33813000,
      avg: 13005,
      min: 10,
      max: 26000,
      nonEmptyCount: 2600,
      uniqueCount: 2600,
    },
  });
  await flushMicrotasks();
  assert.equal(store.activeColumnStats.loading, false);
  assert.equal(store.activeColumnStats.stats?.sum, 33813000);
  assert.equal(statsEmits, 2);

  // Switching back to col 0 hits per-column cache synchronously (zero worker requests)
  mockWorker.posted.length = 0;
  store.selectCell({rowIndex: 0, colIndex: 0});
  assert.equal(store.activeColumnStats.colIndex, 0);
  assert.equal(store.activeColumnStats.loading, false);
  assert.equal(store.activeColumnStats.stats?.nonEmptyCount, 2600);
  assert.equal(
    mockWorker.posted.filter((p) => p.msg.type === 'compute-stats').length,
    0
  );

  store.dispose();
});

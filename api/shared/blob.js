'use strict';
// Blob Storage access for the songbook: index.json + songs/<id>.chordpro
const { BlobServiceClient } = require('@azure/storage-blob');

const CONTAINER = 'songbook';

function container() {
  const conn = process.env.STORAGE_CONNECTION;
  if (!conn) throw new Error('STORAGE_CONNECTION not configured');
  return BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
}

async function ensureContainer() {
  const c = container();
  await c.createIfNotExists();
  return c;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(Buffer.from(d)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

async function readText(name) {
  const b = container().getBlockBlobClient(name);
  if (!(await b.exists())) return null;
  const dl = await b.download();
  return streamToString(dl.readableStreamBody);
}

async function writeText(name, text, contentType = 'text/plain; charset=utf-8') {
  const c = await ensureContainer();
  const b = c.getBlockBlobClient(name);
  await b.upload(text, Buffer.byteLength(text), { blobHTTPHeaders: { blobContentType: contentType } });
}

async function deleteBlob(name) {
  const b = container().getBlockBlobClient(name);
  await b.deleteIfExists();
}

async function readIndex() {
  const t = await readText('index.json');
  const idx = t ? JSON.parse(t) : { songs: [] };
  if (!Array.isArray(idx.songs)) idx.songs = [];
  return idx;
}

async function writeIndex(idx) {
  await writeText('index.json', JSON.stringify(idx, null, 2), 'application/json; charset=utf-8');
}

module.exports = { readText, writeText, deleteBlob, readIndex, writeIndex, ensureContainer };

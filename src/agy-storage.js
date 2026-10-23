// Encrypted central account storage. Native CLI login files remain private 0600.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, lstatSync, realpathSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path';

export function readAgyStorage(path, keyPath) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw new Error('Cannot read AGY account storage'); }
  try {
    const data = JSON.parse(raw);
    if (data?.format !== 'agentlb-agy-encrypted') return data;
    if (!keyPath || data.version !== 1 || data.algorithm !== 'aes-256-gcm') throw new Error();
    const key = readKey(keyPath);
    const iv = Buffer.from(data.iv, 'base64');
    const tag = Buffer.from(data.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('agentlb-agy-encrypted:1'));
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new Error('Cannot decrypt or parse AGY account storage; original file preserved'); }
}

function readKey(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('AGY key must be a private regular file');
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('Invalid AGY encryption key');
  return key;
}

function canonicalPath(path) {
  try { return realpathSync(path); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return resolve(canonicalPath(dirname(path)), basename(path));
  }
}

export function writeAgyStorage(path, data, keyPath) {
  let output = data;
  if (keyPath) {
    const keyRelative = relative(canonicalPath(dirname(path)), canonicalPath(keyPath));
    if (!keyRelative || (!keyRelative.startsWith('..' + '/') && keyRelative !== '..' && !isAbsolute(keyRelative))) {
      throw new Error('AGY encryption key must be outside the accounts directory');
    }
    let key;
    try { key = readKey(keyPath); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // Never replace a lost key for an existing encrypted file.
      let existing;
      try { existing = JSON.parse(readFileSync(path, 'utf8')); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (existing?.format === 'agentlb-agy-encrypted') throw new Error('Missing AGY encryption key');
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
      key = randomBytes(32);
      try { writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 }); }
      catch (err) { if (err.code !== 'EEXIST') throw err; key = readKey(keyPath); }
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('agentlb-agy-encrypted:1'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    output = { format: 'agentlb-agy-encrypted', version: 1, algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(output, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(tmp, 0o600);
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { try { unlinkSync(tmp); } catch { /* preserve the original write error */ } }
}

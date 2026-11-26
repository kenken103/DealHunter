import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const format = Buffer.from("DealHunter-DB-v1\0", "ascii");
const keyLength = 32;
const nonceLength = 12;
const tagLength = 16;
const algorithm = "aes-256-gcm";

class ArchiveError extends Error {}

async function readKey(path, generate) {
  let key;
  try {
    key = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!generate) throw new ArchiveError("The DealHunter database restoration key is missing.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (creationError) {
      if (creationError.code !== "EEXIST") throw creationError;
      return readKey(path, false);
    }
    key = randomBytes(keyLength);
    try {
      await handle.writeFile(key);
    } catch (writeError) {
      await handle.close();
      await rm(path, { force: true });
      throw writeError;
    }
    await handle.close();
  }
  if (key.length !== keyLength) throw new ArchiveError("The DealHunter database restoration key is invalid.");
  return key;
}

function encrypt(dump, key) {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: tagLength });
  cipher.setAAD(format);
  return Buffer.concat([format, nonce, cipher.update(dump), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(archive, key) {
  const ciphertextStart = format.length + nonceLength;
  const tagStart = archive.length - tagLength;
  if (tagStart <= ciphertextStart || !archive.subarray(0, format.length).equals(format)) {
    throw new ArchiveError("The DealHunter database archive format is invalid or unsupported.");
  }
  const nonce = archive.subarray(format.length, ciphertextStart);
  const decipher = createDecipheriv(algorithm, key, nonce, { authTagLength: tagLength });
  decipher.setAAD(format);
  decipher.setAuthTag(archive.subarray(tagStart));
  try {
    return Buffer.concat([decipher.update(archive.subarray(ciphertextStart, tagStart)), decipher.final()]);
  } catch {
    throw new ArchiveError("The database archive could not be authenticated. Check the restoration key and archive.");
  }
}

async function writeAtomically(path, data) {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const pending = join(folder, `.dealhunter-data-${randomBytes(16).toString("hex")}.tmp`);
  try {
    await writeFile(pending, data, { flag: "wx", mode: 0o600 });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

async function run([action, ...paths]) {
  if (!["export", "import"].includes(action) || paths.length !== 3 || paths.some(path => !path)) {
    throw new ArchiveError("Usage: demo-data-crypto.mjs <export|import> <input> <output> <key-file>");
  }
  const [inputPath, outputPath, keyPath] = paths.map(path => resolve(path));
  const comparedPaths = process.platform === "win32" ? paths.map(path => resolve(path).toLowerCase()) : [inputPath, outputPath, keyPath];
  if (new Set(comparedPaths).size !== 3) throw new ArchiveError("Use separate input, output and key files.");

  const input = await readFile(inputPath);
  if (!input.length) throw new ArchiveError("The input archive is empty.");
  const key = await readKey(keyPath, action === "export");
  const result = action === "export" ? encrypt(input, key) : decrypt(input, key);
  await writeAtomically(outputPath, result);
}

run(process.argv.slice(2)).catch(error => {
  console.error(error instanceof ArchiveError ? error.message : "Could not read or write the DealHunter database archive.");
  process.exitCode = 1;
});

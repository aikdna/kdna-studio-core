/**
 * Packaging adapter — secure delegation to kdna-cli.
 *
 * All subprocess calls use execFileSync (not execSync with string interpolation)
 * to prevent command injection. Studio Core calls kdna-cli as the canonical
 * implementation of pack/verify/sign/publish operations.
 */

const { execFileSync } = require('child_process');
const path = require('path');

function packDomain(domainDir, outputDir = null) {
  const args = ['pack', domainDir];
  if (outputDir) args.push('--output', outputDir);
  const result = execFileSync('kdna', args, { encoding: 'utf8', timeout: 60000 });
  return { success: true, output: result.trim() };
}

function packEncryptedDomain(domainDir, licensePath, outputDir = null) {
  const args = ['pack', domainDir, '--encrypt', '--license', licensePath];
  if (outputDir) args.push('--output', outputDir);
  const result = execFileSync('kdna', args, { encoding: 'utf8', timeout: 60000 });
  return { success: true, output: result.trim() };
}

function verifyDomain(domainPath) {
  try {
    const result = execFileSync('kdna', ['verify', domainPath, '--json'], { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(result);
  } catch (e) {
    const stdout = (e.stdout || '').toString();
    try { return JSON.parse(stdout); } catch { return { error: e.message, stdout }; }
  }
}

function validateDomain(domainPath) {
  try {
    const result = execFileSync('kdna', ['validate', domainPath], { encoding: 'utf8', timeout: 30000 });
    return { success: true, output: result.trim() };
  } catch (e) {
    return { success: false, error: e.message, stderr: (e.stderr || '').toString() };
  }
}

function inspectContainer(filePath) {
  try {
    const result = execFileSync('kdna', ['inspect', filePath, '--json'], { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(result);
  } catch { return null; }
}

function signDomain(domainDir) {
  try {
    const result = execFileSync('kdna', ['publish', '--check', domainDir], { encoding: 'utf8', timeout: 30000 });
    return { success: true, output: result.trim() };
  } catch (e) {
    return { success: false, error: (e.stderr || '').toString() || e.message };
  }
}

function generateLicense(domain, issuedTo, savePath = null) {
  const args = ['license', 'generate', domain, '--to', issuedTo];
  if (savePath) args.push('--save', savePath);
  try {
    const result = execFileSync('kdna', args, { encoding: 'utf8', timeout: 15000 });
    return { success: true, output: result.trim() };
  } catch (e) {
    return { success: false, error: (e.stderr || '').toString() || e.message };
  }
}

module.exports = {
  packDomain, packEncryptedDomain, verifyDomain, validateDomain,
  inspectContainer, signDomain, generateLicense,
};

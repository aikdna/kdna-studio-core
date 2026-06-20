/**
 * Runtime CLI adapter for dev-source diagnostics and asset verification.
 *
 * All subprocess calls use execFileSync (not execSync with string interpolation)
 * to prevent command injection. Canonical compile/export is implemented by
 * Studio Core itself and exposed through @aikdna/kdna-studio-cli. kdna-cli is
 * only called here for dev-source diagnostics and runtime verification.
 */

const { execFileSync } = require('child_process');
const path = require('path');

function packDomain(domainDir, outputDir = null) {
  return devBundleSource(domainDir, outputDir);
}

function devBundleSource(domainDir, outputDir = null) {
  const args = ['dev', 'pack', domainDir];
  if (outputDir) args.push('--output', outputDir);
  const result = execFileSync('kdna', args, { encoding: 'utf8', timeout: 60000 });
  return {
    success: true,
    trusted: false,
    canonical: false,
    output: result.trim(),
  };
}

function packEncryptedDomain(domainDir, licensePath, outputDir = null) {
  void domainDir;
  void licensePath;
  void outputDir;
  return {
    success: false,
    error: 'Encrypted-extension packaging has been removed. Build a licensed .kdna asset and activate it through the entitlement API.',
  };
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
    const result = execFileSync('kdna', ['dev', 'validate', domainPath], { encoding: 'utf8', timeout: 30000 });
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
  packDomain, devBundleSource, packEncryptedDomain, verifyDomain, validateDomain,
  inspectContainer, signDomain, generateLicense,
};

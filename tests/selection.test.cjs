const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.join(__dirname, '..')

function run(cwd, cmd, args, input) {
  const result = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-intro-selection-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const source = path.join(folder, 'source'), remote = path.join(folder, 'remote.git'), clone = path.join(folder, 'clone')
  fs.mkdirSync(source)
  for (const name of ['agent-common.sh', 'pull.sh', 'build.sh', 'pet.sh']) fs.copyFileSync(path.join(root, name), path.join(source, name))
  for (const edition of ['codex', 'claude']) {
    const dir = path.join(source, 'editions', edition)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'asset.bin'), `unique-${edition}-video-data`)
    for (const script of ['build.sh', 'pet.sh']) {
      fs.writeFileSync(path.join(dir, script), `#!/bin/bash\nprintf '%s\\n' '${edition} ${script}' "$@"\n`, { mode: 0o755 })
    }
  }
  run(source, 'git', ['init', '-b', 'main'])
  run(source, 'git', ['config', 'user.name', 'Fixture'])
  run(source, 'git', ['config', 'user.email', 'fixture@example.invalid'])
  run(source, 'git', ['add', '.'])
  run(source, 'git', ['commit', '-m', 'Fixture'])
  run(folder, 'git', ['init', '--bare', remote])
  run(folder, 'git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true'])
  run(source, 'git', ['remote', 'add', 'origin', remote])
  run(source, 'git', ['push', '-u', 'origin', 'main'])
  run(folder, 'git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  run(folder, 'git', ['clone', '--filter=blob:none', '--sparse', '--single-branch', `file://${remote}`, clone])
  return { source, clone }
}

for (const [edition, selected] of [['codex', ['codex']], ['claude', ['claude']], ['all', ['codex', 'claude']]]) {
  test(`partial clone downloads only ${edition} and routes the build`, t => {
    const { source, clone } = fixture(t)
    run(clone, 'bash', ['pull.sh', edition, '--build'])
    assert.equal(run(clone, 'git', ['config', '--get', 'agentIntro.edition']).trim(), edition)
    const missing = run(clone, 'git', ['rev-list', '--objects', '--missing=print', 'HEAD'])
    for (const variant of ['codex', 'claude']) {
      assert.equal(fs.existsSync(path.join(clone, 'editions', variant, 'asset.bin')), selected.includes(variant))
      const blob = run(source, 'git', ['rev-parse', `HEAD:editions/${variant}/asset.bin`]).trim()
      assert.equal(missing.includes(`?${blob}`), !selected.includes(variant), 'unselected video blob must remain undownloaded')
    }
    const output = run(clone, 'bash', ['build.sh', edition, '--install'])
    for (const variant of selected) assert.match(output, new RegExp(`${variant} build.sh`))
    assert.match(output, /--install/)
  })
}

test('interactive choice, remembered default, switching, and independent pet routing', t => {
  const { clone } = fixture(t)
  run(clone, 'bash', ['pull.sh', '--no-update'], '2\n')
  assert.equal(run(clone, 'git', ['config', '--get', 'agentIntro.edition']).trim(), 'claude')
  assert.match(run(clone, 'bash', ['pet.sh', 'status'], '\n'), /claude pet.sh\nstatus/)
  run(clone, 'bash', ['pull.sh', 'all', '--no-update'])
  assert.match(run(clone, 'bash', ['pet.sh', 'all', 'quota', 'off']), /codex pet.sh\nquota\noff\nclaude pet.sh\nquota\noff/)
  run(clone, 'bash', ['pull.sh', 'codex', '--no-update'])
  assert.equal(fs.existsSync(path.join(clone, 'editions', 'claude', 'asset.bin')), false)
  assert.equal(fs.existsSync(path.join(clone, 'editions', 'codex', 'asset.bin')), true)
})

for (const selected of ['codex', 'claude']) {
  test(`updating codex to ${selected} does not download new assets for the unselected edition`, t => {
    const { source, clone } = fixture(t)
    run(clone, 'bash', ['pull.sh', 'codex', '--no-update'])
    for (const edition of ['codex', 'claude']) {
      fs.writeFileSync(path.join(source, 'editions', edition, 'asset.bin'), `updated-${edition}-video-data`)
    }
    run(source, 'git', ['add', '.'])
    run(source, 'git', ['commit', '-m', 'Update both editions'])
    run(source, 'git', ['push'])

    run(clone, 'bash', ['pull.sh', selected])
    assert.equal(fs.readFileSync(path.join(clone, 'editions', selected, 'asset.bin'), 'utf8'), `updated-${selected}-video-data`)
    const unselected = selected === 'codex' ? 'claude' : 'codex'
    assert.equal(fs.existsSync(path.join(clone, 'editions', unselected, 'asset.bin')), false)
    const missing = run(clone, 'git', ['rev-list', '--objects', '--missing=print', 'HEAD'])
    const blob = run(source, 'git', ['rev-parse', `HEAD:editions/${unselected}/asset.bin`]).trim()
    assert.ok(missing.includes(`?${blob}`), 'the updated unselected video blob must remain undownloaded')
  })
}

test('invalid input, unavailable sources, EOF, and local edits stop safely', t => {
  const { clone } = fixture(t)
  for (const args of [['pull.sh', 'mimo'], ['build.sh', 'codex'], ['pull.sh', 'codex', '--build', '--install']]) {
    const result = spawnSync('bash', args, { cwd: clone, encoding: 'utf8', input: '' })
    assert.notEqual(result.status, 0)
  }
  assert.notEqual(spawnSync('bash', ['pull.sh'], { cwd: clone, input: '', encoding: 'utf8' }).status, 0)
  fs.appendFileSync(path.join(clone, 'agent-common.sh'), '\n# local user edit\n')
  const dirty = spawnSync('bash', ['pull.sh', 'all', '--no-update'], { cwd: clone, encoding: 'utf8' })
  assert.notEqual(dirty.status, 0)
  assert.match(dirty.stderr, /未提交改动/)
  assert.match(fs.readFileSync(path.join(clone, 'agent-common.sh'), 'utf8'), /local user edit/)
})

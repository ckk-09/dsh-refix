// dsh-patient v1 — 验收用患者插件：host-only，带 health host 方法
// 后续阶段通过此方法注入故障（抛错）与探测（invoke 探针）。
return {
  name: 'dsh-patient',
  apply() {
    harness.handle('health', function () { return { ok: true, note: 'patient-v1 alive' } })
    console.log('dsh-patient v1 running')
  },
}

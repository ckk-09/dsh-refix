// dsh-patient-broken — AC1.3 夹具：health 宿主方法必现抛错（模拟"宿主方法抛错"症状）
return {
  name: 'dsh-patient-broken',
  apply() {
    harness.handle('health', function () {
      throw new Error('patient-broken: health 探针必现故障（验收注入）')
    })
    console.log('dsh-patient-broken running (health 会抛错)')
  },
}

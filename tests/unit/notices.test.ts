import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { useQaStore } from '@/stores/qa'

describe('transient operation notices', () => {
  let pinia: ReturnType<typeof createPinia>
  beforeEach(() => { vi.useFakeTimers(); pinia = createPinia(); setActivePinia(pinia) })
  afterEach(() => { disposePinia(pinia); vi.useRealTimers() })

  it.each(['success', 'error', 'info', 'loading'] as const)('dismisses a %s notice after two seconds', (tone) => {
    const store = useQaStore()
    store.showNotice('操作结果', tone)
    vi.advanceTimersByTime(1999)
    expect(store.notice).toEqual({ tone, message: '操作结果' })
    vi.advanceTimersByTime(1)
    expect(store.notice).toBeNull()
  })

  it('gives a replacement notice a full two seconds', () => {
    const store = useQaStore()
    store.showNotice('旧结果', 'success')
    vi.advanceTimersByTime(1500)
    store.showNotice('新结果', 'success')
    vi.advanceTimersByTime(500)
    expect(store.notice?.message).toBe('新结果')
    vi.advanceTimersByTime(1499)
    expect(store.notice?.message).toBe('新结果')
    vi.advanceTimersByTime(1)
    expect(store.notice).toBeNull()
  })

  it('manual dismissal clears the old timer without dismissing a later notice', () => {
    const store = useQaStore()
    store.showNotice('旧结果')
    vi.advanceTimersByTime(1000)
    store.clearNotice()
    expect(store.notice).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    store.showNotice('新结果')
    vi.advanceTimersByTime(1000)
    expect(store.notice?.message).toBe('新结果')
  })

  it('disposes the pending timer with the store', () => {
    const store = useQaStore()
    store.showNotice('结果')
    store.$dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})

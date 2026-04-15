import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseWorkspaceJson } from '@utils/index'
import type {
  OpenAiTier,
  SubtitleCue,
  ModelId,
  SubtitleWorkspace,
  TranslationLanguage,
  TranslationMemoryEntry,
} from '@utils/types'
import { AnimatedLogo } from './components/AnimatedLogo'
import { HeaderMatrixOverlay } from './components/HeaderMatrixOverlay'

function formatTs(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  const p = (n: number, w: number) => n.toString().padStart(w, '0')
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(milli, 3)}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isTranslationCancelledError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /translation cancelled/i.test(msg)
}

function replaceAllInString(
  haystack: string,
  find: string,
  replacement: string,
  ignoreCase: boolean,
): string {
  if (!find) return haystack
  if (!ignoreCase) return haystack.split(find).join(replacement)
  try {
    return haystack.replace(new RegExp(escapeRegExp(find), 'gi'), replacement)
  } catch {
    return haystack
  }
}

export function App(): JSX.Element {
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [translated, setTranslated] = useState<SubtitleCue[] | null>(null)
  const [fileLabel, setFileLabel] = useState<string>('')
  const [model, setModel] = useState<ModelId>('qwen9b')
  const [inferenceMode, setInferenceMode] = useState<'gpu' | 'cpu'>('gpu')
  const [busy, setBusy] = useState(false)
  const [retranslatingIdx, setRetranslatingIdx] = useState<number | null>(null)
  const [progress, setProgress] = useState(0)
  const [streamPreview, setStreamPreview] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [replaceScope, setReplaceScope] = useState<'original' | 'translated' | 'both'>('both')
  const [replaceIgnoreCase, setReplaceIgnoreCase] = useState(false)
  const [replaceHint, setReplaceHint] = useState<string | null>(null)
  const [saveOriginalHint, setSaveOriginalHint] = useState<string | null>(null)
  const [workspaceHint, setWorkspaceHint] = useState<string | null>(null)
  const [navMenuOpen, setNavMenuOpen] = useState(false)
  const [geminiApiKeyConfigured, setGeminiApiKeyConfigured] = useState(false)
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('')
  const [openaiApiKeyConfigured, setOpenaiApiKeyConfigured] = useState(false)
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState('')
  const [openAiTier, setOpenAiTier] = useState<OpenAiTier>('normal')
  const [cloudTargetLanguage, setCloudTargetLanguage] = useState<TranslationLanguage>('myanmar')
  const [translationMemory, setTranslationMemory] = useState<TranslationMemoryEntry[]>([])
  const [trainWindowOpen, setTrainWindowOpen] = useState(false)
  const [trainDirty, setTrainDirty] = useState(false)
  const [memorySourceDraft, setMemorySourceDraft] = useState('')
  const [memoryTargetDraft, setMemoryTargetDraft] = useState('')
  const [memoryHint, setMemoryHint] = useState<string | null>(null)
  const [cloudSettingsTab, setCloudSettingsTab] = useState<'gemini' | 'openai'>('gemini')

  const api = window.subtitleApp

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.getConfig()
        if (
          cfg.selectedModel === 'qwen9b' ||
          cfg.selectedModel === 'qwen27b' ||
          cfg.selectedModel === 'gemini' ||
          cfg.selectedModel === 'openai'
        ) {
          setModel(cfg.selectedModel)
        }
        setGeminiApiKeyConfigured(cfg.geminiApiKeyConfigured)
        setOpenaiApiKeyConfigured(cfg.openaiApiKeyConfigured)
        setOpenAiTier(cfg.openaiTier)
        setCloudTargetLanguage(cfg.cloudTargetLanguage)
        setTranslationMemory(cfg.translationMemory ?? [])
        setTrainDirty(false)
        if (cfg.inferenceMode === 'cpu' || cfg.inferenceMode === 'gpu') {
          setInferenceMode(cfg.inferenceMode)
        } else {
          setInferenceMode(cfg.nGpuLayers === 0 ? 'cpu' : 'gpu')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [api])

  useEffect(() => {
    if (model === 'gemini') setCloudSettingsTab('gemini')
    if (model === 'openai') setCloudSettingsTab('openai')
  }, [model])

  useEffect(() => {
    const offP = api.onTranslateProgress((d) => {
      if (typeof d.percent === 'number') setProgress(d.percent)
    })
    const offS = api.onTranslateStream((d) => {
      if (typeof d.partial === 'string') setStreamPreview(d.partial)
    })
    return () => {
      offP()
      offS()
    }
  }, [api])

  useEffect(() => {
    if (!navMenuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navMenuOpen])

  const loadFromText = useCallback(
    async (text: string, label: string) => {
      setError(null)
      setSaveOriginalHint(null)
      setWorkspaceHint(null)
      const parsed = await api.parseSubtitle(text)
      setCues(parsed)
      setTranslated(null)
      setFileLabel(label)
    },
    [api],
  )

  const onOpen = useCallback(async () => {
    const r = await api.openSrtDialog()
    if (!r) return
    await loadFromText(r.text, r.filePath)
  }, [api, loadFromText])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const f = e.dataTransfer.files?.[0]
      if (!f) return
      if (!f.name.toLowerCase().endsWith('.srt')) {
        setError('Please drop a .srt file.')
        return
      }
      try {
        const p = api.pathForFile(f)
        const text = await api.readUtf8File(p)
        await loadFromText(text, p)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [api, loadFromText],
  )

  const onModelChange = useCallback(
    async (m: ModelId) => {
      setModel(m)
      await api.setConfig({ selectedModel: m })
    },
    [api],
  )

  const onInferenceModeChange = useCallback(
    async (m: 'gpu' | 'cpu') => {
      setInferenceMode(m)
      await api.setConfig({ inferenceMode: m })
    },
    [api],
  )

  const onSaveGeminiKey = useCallback(async () => {
    const v = geminiKeyDraft.trim()
    await api.setConfig({ geminiApiKey: v })
    setGeminiApiKeyConfigured(v.length > 0)
    setGeminiKeyDraft('')
  }, [api, geminiKeyDraft])

  const onSaveOpenAiKey = useCallback(async () => {
    const v = openaiKeyDraft.trim()
    await api.setConfig({ openaiApiKey: v })
    setOpenaiApiKeyConfigured(v.length > 0)
    setOpenaiKeyDraft('')
  }, [api, openaiKeyDraft])

  const onOpenAiTierChange = useCallback(
    async (tier: OpenAiTier) => {
      setOpenAiTier(tier)
      await api.setConfig({ openaiTier: tier })
    },
    [api],
  )

  const onCloudTargetLanguageChange = useCallback(
    async (lang: TranslationLanguage) => {
      setCloudTargetLanguage(lang)
      await api.setConfig({ cloudTargetLanguage: lang })
    },
    [api],
  )

  const onAddTranslationMemory = useCallback(async () => {
    const source = memorySourceDraft.trim()
    const target = memoryTargetDraft.trim()
    if (!source || !target) {
      setMemoryHint('Enter both source phrase and preferred translation.')
      return
    }
    const next = [...translationMemory.filter((entry) => entry.source !== source), { source, target }]
    setTranslationMemory(next)
    setMemorySourceDraft('')
    setMemoryTargetDraft('')
    setMemoryHint('Saved in memory.')
    setTrainDirty(false)
    await api.setConfig({ translationMemory: next })
  }, [api, memorySourceDraft, memoryTargetDraft, translationMemory])

  const onDeleteTranslationMemory = useCallback(
    async (idx: number) => {
      const next = translationMemory.filter((_, i) => i !== idx)
      setTranslationMemory(next)
      setMemoryHint('Removed from memory.')
      setTrainDirty(false)
      await api.setConfig({ translationMemory: next })
    },
    [api, translationMemory],
  )

  const onMemoryEntryChange = useCallback(
    (idx: number, field: 'source' | 'target', value: string) => {
      setTranslationMemory((prev) => prev.map((entry, i) => (i === idx ? { ...entry, [field]: value } : entry)))
      setTrainDirty(true)
      setMemoryHint(null)
    },
    [],
  )

  const onSaveTrainingMemory = useCallback(async () => {
    const cleaned = translationMemory
      .map((entry) => ({ source: entry.source.trim(), target: entry.target.trim() }))
      .filter((entry) => entry.source.length > 0 && entry.target.length > 0)
    setTranslationMemory(cleaned)
    await api.setConfig({ translationMemory: cleaned })
    setTrainDirty(false)
    setMemoryHint('Training data saved.')
  }, [api, translationMemory])

  const onStopTranslate = useCallback(() => {
    void api.cancelTranslate()
  }, [api])

  const onTranslate = useCallback(async () => {
    if (!cues.length) return
    setError(null)
    setBusy(true)
    setProgress(0)
    setStreamPreview('')
    try {
      const out = await api.translate({
        cues,
        modelKey: model,
        targetLanguage: cloudTargetLanguage,
        translationMemory,
      })
      setTranslated(out)
      setProgress(100)
    } catch (e) {
      if (!isTranslationCancelledError(e)) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }, [api, cues, model, cloudTargetLanguage, translationMemory])

  const onOriginalCueTextChange = useCallback((idx: number, text: string) => {
    setCues((prev) => prev.map((c, i) => (i === idx ? { ...c, text } : c)))
  }, [])

  const onTranslatedCueTextChange = useCallback(
    (idx: number, text: string) => {
      setTranslated((prev) => {
        if (prev) {
          return prev.map((c, i) => (i === idx ? { ...c, text } : c))
        }
        return cues.map((c, i) => ({
          ...c,
          text: i === idx ? text : '',
        }))
      })
    },
    [cues],
  )

  const onReplaceAll = useCallback(() => {
    const find = findText.trim()
    if (!find) {
      setReplaceHint('Enter text to find.')
      return
    }
    if (
      (replaceScope === 'translated' || replaceScope === 'both') &&
      (!translated?.length)
    ) {
      if (replaceScope === 'translated') {
        setReplaceHint('No translated text yet. Translate or type on the right first.')
        return
      }
    }

    let changedOriginal = 0
    let changedTranslated = 0

    if (replaceScope === 'original' || replaceScope === 'both') {
      setCues((prev) =>
        prev.map((c) => {
          const next = replaceAllInString(c.text, find, replaceText, replaceIgnoreCase)
          if (next !== c.text) changedOriginal += 1
          return { ...c, text: next }
        }),
      )
    }

    if ((replaceScope === 'translated' || replaceScope === 'both') && translated?.length) {
      setTranslated((prev) => {
        if (!prev?.length) return prev
        return prev.map((c) => {
          const next = replaceAllInString(c.text, find, replaceText, replaceIgnoreCase)
          if (next !== c.text) changedTranslated += 1
          return { ...c, text: next }
        })
      })
    }

    const parts: string[] = []
    if (replaceScope === 'original' || replaceScope === 'both') {
      parts.push(`${changedOriginal} cue(s) in Original`)
    }
    if ((replaceScope === 'translated' || replaceScope === 'both') && translated?.length) {
      parts.push(`${changedTranslated} cue(s) in Translated`)
    }
    setReplaceHint(parts.join(' · ') || 'No matches.')
  }, [findText, replaceText, replaceScope, replaceIgnoreCase, translated])

  const onExport = useCallback(async () => {
    const src = translated
    if (!src?.length) return
    const base = fileLabel ? fileLabel.replace(/\.[^.]+$/, '') : 'subtitles'
    const exportSuffix =
      (model === 'gemini' || model === 'openai') && cloudTargetLanguage === 'thai'
        ? 'thai'
        : 'myanmar'
    const path = await api.saveSrtDialog(`${base}.${exportSuffix}.srt`)
    if (!path) return
    const data = await api.serializeSubtitle(src)
    await api.writeUtf8File(path, data)
  }, [api, translated, fileLabel, model, cloudTargetLanguage])

  const onRetranslateLine = useCallback(
    async (idx: number) => {
      const cue = cues[idx]
      if (!cue || retranslatingIdx !== null || busy) return
      setRetranslatingIdx(idx)
      setError(null)
      try {
        const newText = await api.translateOne({
          cue,
          modelKey: model,
          targetLanguage: cloudTargetLanguage,
          translationMemory,
        })
        if (newText === cue.text) {
          return
        }
        setTranslated((prev) => {
          const base = prev ?? cues.map((c) => ({ ...c, text: '' }))
          return base.map((c, i) => (i === idx ? { ...c, text: newText } : c))
        })
      } catch (e) {
        if (!isTranslationCancelledError(e)) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        setRetranslatingIdx(null)
      }
    },
    [api, busy, cues, model, retranslatingIdx, cloudTargetLanguage, translationMemory],
  )

  const onSaveOriginal = useCallback(async () => {
    if (!cues.length || !fileLabel) return
    setError(null)
    setSaveOriginalHint(null)
    try {
      const data = await api.serializeSubtitle(cues)
      await api.writeUtf8File(fileLabel, data)
      setSaveOriginalHint('Saved changes to the original file.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api, cues, fileLabel])

  const defaultWorkspaceFileName = useMemo(() => {
    if (!fileLabel) return 'subtitle-workspace.bsw'
    return fileLabel.replace(/\.[^.\\/]+$/, '') + '.bsw'
  }, [fileLabel])

  const onSaveWorkspace = useCallback(async () => {
    if (!cues.length) {
      setError('Open subtitles first, then you can save a workspace.')
      return
    }
    setError(null)
    setWorkspaceHint(null)
    try {
      const path = await api.saveWorkspaceDialog(defaultWorkspaceFileName)
      if (!path) return
      const ws: SubtitleWorkspace = {
        version: 1,
        savedAt: new Date().toISOString(),
        sourceFileLabel: fileLabel,
        cues,
        translated,
        findText,
        replaceText,
        replaceScope,
        replaceIgnoreCase,
        selectedModel: model,
        inferenceMode,
        openaiTier: openAiTier,
        cloudTargetLanguage,
        translationMemory,
      }
      await api.writeUtf8File(path, JSON.stringify(ws, null, 2))
      setWorkspaceHint(`Workspace saved. You can open this file later to continue editing.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [
    api,
    cues,
    translated,
    fileLabel,
    findText,
    replaceText,
    replaceScope,
    replaceIgnoreCase,
    model,
    inferenceMode,
    openAiTier,
    cloudTargetLanguage,
    translationMemory,
    defaultWorkspaceFileName,
  ])

  const onOpenWorkspace = useCallback(async () => {
    setError(null)
    setWorkspaceHint(null)
    setSaveOriginalHint(null)
    try {
      const r = await api.openWorkspaceDialog()
      if (!r) return
      const ws = parseWorkspaceJson(r.text)
      setCues(ws.cues)
      setTranslated(ws.translated)
      setFileLabel(ws.sourceFileLabel)
      setFindText(ws.findText)
      setReplaceText(ws.replaceText)
      setReplaceScope(ws.replaceScope)
      setReplaceIgnoreCase(ws.replaceIgnoreCase)
      setModel(ws.selectedModel)
      setInferenceMode(ws.inferenceMode)
      const nextTier = ws.openaiTier ?? 'normal'
      const nextTargetLanguage = ws.cloudTargetLanguage ?? 'myanmar'
      const nextTranslationMemory = ws.translationMemory ?? []
      setOpenAiTier(nextTier)
      setCloudTargetLanguage(nextTargetLanguage)
      setTranslationMemory(nextTranslationMemory)
      setTrainDirty(false)
      await api.setConfig({
        selectedModel: ws.selectedModel,
        inferenceMode: ws.inferenceMode,
        openaiTier: nextTier,
        cloudTargetLanguage: nextTargetLanguage,
        translationMemory: nextTranslationMemory,
      })
      setWorkspaceHint(`Loaded workspace from ${r.filePath}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api])

  const translatingFx = busy || retranslatingIdx !== null
  const translatedColumnLabel =
    (model === 'gemini' || model === 'openai') && cloudTargetLanguage === 'thai'
      ? 'Translated (TH)'
      : 'Translated (MY)'
  const translatedPlaceholder =
    (model === 'gemini' || model === 'openai') && cloudTargetLanguage === 'thai'
      ? 'Thai translation...'
      : 'Burmese translation...'

  const left = cues

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()}>
      <header className="top">
        {translatingFx ? <HeaderMatrixOverlay /> : null}
        <div className="brand">
          <div className="brandRow">
            <AnimatedLogo isTranslating={busy || retranslatingIdx !== null} size={88} />
            <div className="brandText">
              <div className="title">Burmese Subtitle Translator</div>
              <div className="subtitle">Local AI model Translation APP</div>
            </div>
          </div>
        </div>

        <div className="headerNav">
          <div className="navMenu">
            <button
              type="button"
              className="navMenuToggle"
              aria-expanded={navMenuOpen}
              aria-controls="app-nav-menu"
              aria-label="Open menu"
              onClick={() => setNavMenuOpen((o) => !o)}
            >
              <span className="navMenuToggleBar" />
              <span className="navMenuToggleBar" />
              <span className="navMenuToggleBar" />
            </button>
            {navMenuOpen ? (
              <>
                <div
                  className="navMenuBackdrop"
                  aria-hidden
                  onClick={() => setNavMenuOpen(false)}
                />
                <div className="navMenuPanel" id="app-nav-menu" role="menu">
                  <label className="field navMenuField">
                    <span>Model</span>
                    <select
                      value={model}
                      disabled={busy}
                      onChange={(e) => void onModelChange(e.target.value as ModelId)}
                    >
                      <option value="qwen9b">Performance (local)</option>
                      <option value="qwen27b">Quality (local)</option>
                      <option value="gemini">Cloud (Gemini)</option>
                      <option value="openai">Cloud (OpenAI)</option>
                    </select>
                  </label>

                  <div className="navMenuCloudSection" role="group" aria-label="Cloud API keys">
                    <label className="field navMenuField">
                      <span>Cloud translate to</span>
                      <select
                        value={cloudTargetLanguage}
                        disabled={busy || (model !== 'gemini' && model !== 'openai')}
                        onChange={(e) =>
                          void onCloudTargetLanguageChange(e.target.value as TranslationLanguage)
                        }
                      >
                        <option value="myanmar">Myanmar (Burmese)</option>
                        <option value="thai">Thai</option>
                      </select>
                    </label>

                    <div className="navMenuCloudTabs">
                      <button
                        type="button"
                        className={
                          cloudSettingsTab === 'gemini'
                            ? 'navMenuCloudTab navMenuCloudTabActive'
                            : 'navMenuCloudTab'
                        }
                        disabled={busy}
                        onClick={() => setCloudSettingsTab('gemini')}
                      >
                        Gemini
                      </button>
                      <button
                        type="button"
                        className={
                          cloudSettingsTab === 'openai'
                            ? 'navMenuCloudTab navMenuCloudTabActive'
                            : 'navMenuCloudTab'
                        }
                        disabled={busy}
                        onClick={() => setCloudSettingsTab('openai')}
                      >
                        OpenAI
                      </button>
                    </div>

                    {cloudSettingsTab === 'gemini' ? (
                      <div className="field navMenuField navMenuGemini">
                        <span>Gemini API key</span>
                        <p className="navMenuGeminiHint">
                          {geminiApiKeyConfigured ? (
                            <span className="navMenuGeminiOk">Key saved.</span>
                          ) : (
                            <span>Paste a key from Google AI Studio, then Save.</span>
                          )}{' '}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Get a key
                          </a>
                        </p>
                        <div className="navMenuGeminiRow">
                          <input
                            type="password"
                            className="navMenuGeminiInput"
                            value={geminiKeyDraft}
                            onChange={(e) => setGeminiKeyDraft(e.target.value)}
                            placeholder="AIza…"
                            disabled={busy}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="btn navMenuGeminiSave"
                            disabled={busy || !geminiKeyDraft.trim()}
                            onClick={() => void onSaveGeminiKey()}
                          >
                            Save key
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="field navMenuField navMenuOpenAi">
                        <span>OpenAI API key</span>
                        <p className="navMenuGeminiHint">
                          {openaiApiKeyConfigured ? (
                            <span className="navMenuGeminiOk">Key saved.</span>
                          ) : (
                            <span>Paste a key from OpenAI, then Save.</span>
                          )}{' '}
                          <a
                            href="https://platform.openai.com/api-keys"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Get a key
                          </a>
                        </p>
                        <div className="navMenuGeminiRow">
                          <input
                            type="password"
                            className="navMenuGeminiInput"
                            value={openaiKeyDraft}
                            onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                            placeholder="sk-…"
                            disabled={busy}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="btn navMenuGeminiSave"
                            disabled={busy || !openaiKeyDraft.trim()}
                            onClick={() => void onSaveOpenAiKey()}
                          >
                            Save key
                          </button>
                        </div>

                        <label className="field navMenuField navMenuOpenAiTier">
                          <span>OpenAI model</span>
                          <select
                            value={openAiTier}
                            disabled={busy}
                            onChange={(e) =>
                              void onOpenAiTierChange(e.target.value as OpenAiTier)
                            }
                          >
                            <option value="normal">Normal — GPT-5 mini</option>
                            <option value="premium">Premium — GPT-5</option>
                          </select>
                        </label>
                      </div>
                    )}
                  </div>

                  <label className="field navMenuField">
                    <span>
                      Inference{' '}
                      {model === 'gemini' || model === 'openai' ? '(local only)' : ''}
                    </span>
                    <select
                      value={inferenceMode}
                      disabled={busy || model === 'gemini' || model === 'openai'}
                      onChange={(e) => void onInferenceModeChange(e.target.value as 'gpu' | 'cpu')}
                    >
                      <option value="gpu">GPU</option>
                      <option value="cpu">CPU</option>
                    </select>
                  </label>

                </div>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <nav className="menubar" aria-label="Main actions">
        <div className="controls">
          <button type="button" className="btn" onClick={() => void onOpen()} disabled={busy}>
            Open .srt
          </button>
          <button
            type="button"
            className="btn"
            title="Open training memory window"
            onClick={() => {
              setTrainWindowOpen(true)
              setNavMenuOpen(false)
            }}
            disabled={busy}
          >
            Train
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void onExport()}
            disabled={busy || !translated?.length}
          >
            Export .srt
          </button>
          <button
            type="button"
            className="btn"
            title="Restore a previously saved .bsw session"
            onClick={() => void onOpenWorkspace()}
            disabled={busy}
          >
            Open workspace
          </button>
          <button
            type="button"
            className="btn"
            title="Save cues, translations, and editor state to a .bsw file"
            onClick={() => void onSaveWorkspace()}
            disabled={busy || !cues.length}
          >
            Save workspace
          </button>
          <button type="button" className="btn primary" onClick={() => void onTranslate()} disabled={busy || !cues.length}>
            Translate
          </button>
          <button
            type="button"
            className="btn btnStop"
            title="Stop translation"
            onClick={() => onStopTranslate()}
            disabled={!busy && retranslatingIdx === null}
          >
            Stop
          </button>
        </div>
      </nav>

      {cues.length > 0 ? (
        <div className="editBar">
          <span className="editBarLabel">Find &amp; replace</span>
          <input
            type="text"
            className="editInput"
            placeholder="Find"
            value={findText}
            disabled={busy}
            onChange={(e) => setFindText(e.target.value)}
            aria-label="Find text"
          />
          <input
            type="text"
            className="editInput"
            placeholder="Replace with"
            value={replaceText}
            disabled={busy}
            onChange={(e) => setReplaceText(e.target.value)}
            aria-label="Replace with"
          />
          <label className="editCheck">
            <input
              type="checkbox"
              checked={replaceIgnoreCase}
              disabled={busy}
              onChange={(e) => setReplaceIgnoreCase(e.target.checked)}
            />
            Ignore case
          </label>
          <label className="field editScope">
            <span>In</span>
            <select
              value={replaceScope}
              disabled={busy}
              onChange={(e) => setReplaceScope(e.target.value as 'original' | 'translated' | 'both')}
            >
              <option value="both">Both columns</option>
              <option value="original">Original only</option>
              <option value="translated">Translated only</option>
            </select>
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void onReplaceAll()}>
            Replace all
          </button>
          <button
            type="button"
            className="btn"
            title="Overwrite the opened .srt with the edited English text"
            onClick={() => void onSaveOriginal()}
            disabled={busy || !cues.length || !fileLabel}
          >
            Save
          </button>
          {replaceHint ? <span className="editHint">{replaceHint}</span> : null}
        </div>
      ) : null}

      {error ? <div className="banner error">{error}</div> : null}

      {saveOriginalHint ? <div className="banner subtle">{saveOriginalHint}</div> : null}

      {workspaceHint ? <div className="banner subtle">{workspaceHint}</div> : null}

      {busy ? (
        <div className="progressRow">
          <div className="bar">
            <div className="fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="progressLabel">{progress}%</div>
        </div>
      ) : null}

      {busy && streamPreview ? <div className="streamPreview">{streamPreview}</div> : null}

      <main
        className={`sheet ${busy ? 'dim' : ''}`}
        onDrop={(e) => void onDrop(e)}
        onDragOver={(e) => e.preventDefault()}
      >
        {cues.length === 0 ? (
          <div className="sheetEmpty">
            <div className="empty">
              Drag & drop a .srt file here, or click <button onClick={() => void onOpen()}>Open .srt</button>
            </div>
          </div>
        ) : (
          <div className="sheetFrame">
            <div className="sheetHeaderRow">
              <div className="sheetColHead">Original (EN)</div>
              <div className="sheetColHead">
                {translatedColumnLabel}
                {!translated?.length ? (
                  <span className="paneHeaderHint"> — edit after Translate, or type Burmese here</span>
                ) : null}
              </div>
            </div>
            <div className="sheetScroll">
              {left.map((c, idx) => {
                const tr = translated?.[idx]?.text ?? ''
                return (
                  <div key={`pair-${c.index}-${idx}`} className="cuePair">
                    <div className="cueCell">
                      <div className="cueMeta">
                        <span className="idx">{c.index}</span>
                        <span className="ts">
                          {formatTs(c.startMs)} → {formatTs(c.endMs)}
                        </span>
                      </div>
                      <textarea
                        className="cueTextarea"
                        value={c.text}
                        disabled={busy}
                        spellCheck={false}
                        rows={Math.min(8, Math.max(2, c.text.split('\n').length))}
                        onChange={(e) => onOriginalCueTextChange(idx, e.target.value)}
                      />
                    </div>
                    <div className="cueCell">
                      <div className="cueMeta">
                        <span className="idx">{c.index}</span>
                        <span className="ts">
                          {formatTs(c.startMs)} → {formatTs(c.endMs)}
                        </span>
                        <button
                          type="button"
                          className="cueRetranslateBtn"
                          title="Retranslate this line (current model)"
                          aria-label="Retranslate this line"
                          disabled={busy || retranslatingIdx !== null}
                          onClick={() => void onRetranslateLine(idx)}
                        >
                          {retranslatingIdx === idx ? (
                            <span className="cueRetranslateSpinner" aria-hidden />
                          ) : (
                            <svg
                              className="cueRetranslateIcon"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
                              aria-hidden
                            >
                              <path
                                d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M3 3v5h5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M21 21v-5h-5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      </div>
                      <textarea
                        className="cueTextarea"
                        value={tr}
                        disabled={busy || retranslatingIdx === idx}
                        spellCheck={false}
                        placeholder={translatedPlaceholder}
                        rows={Math.min(8, Math.max(2, tr.split('\n').length || 2))}
                        onChange={(e) => onTranslatedCueTextChange(idx, e.target.value)}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </main>

      {trainWindowOpen ? (
        <div className="trainModalBackdrop" onClick={() => setTrainWindowOpen(false)}>
          <section className="trainModal" onClick={(e) => e.stopPropagation()}>
            <div className="trainModalHeader">
              <div className="trainModalTitle">Translation Training Memory</div>
              <button type="button" className="btn" onClick={() => setTrainWindowOpen(false)}>
                Close
              </button>
            </div>

            <div className="trainModalAddRow">
              <input
                type="text"
                className="editInput trainInput"
                value={memorySourceDraft}
                onChange={(e) => setMemorySourceDraft(e.target.value)}
                placeholder="English source line or phrase"
                spellCheck={false}
              />
              <input
                type="text"
                className="editInput trainInput"
                value={memoryTargetDraft}
                onChange={(e) => setMemoryTargetDraft(e.target.value)}
                placeholder="Preferred Myanmar translation"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                disabled={!memorySourceDraft.trim() || !memoryTargetDraft.trim()}
                onClick={() => void onAddTranslationMemory()}
              >
                Add
              </button>
            </div>

            <div className="trainModalGridHead">
              <div>English</div>
              <div>Myanmar</div>
              <div>Action</div>
            </div>
            <div className="trainModalList">
              {translationMemory.length ? (
                translationMemory.map((entry, idx) => (
                  <div key={`${entry.source}-${idx}`} className="trainModalRow">
                    <textarea
                      className="cueTextarea trainTextarea"
                      value={entry.source}
                      onChange={(e) => onMemoryEntryChange(idx, 'source', e.target.value)}
                      spellCheck={false}
                      rows={2}
                    />
                    <textarea
                      className="cueTextarea trainTextarea"
                      value={entry.target}
                      onChange={(e) => onMemoryEntryChange(idx, 'target', e.target.value)}
                      spellCheck={false}
                      rows={2}
                    />
                    <button
                      type="button"
                      className="btn btnStop"
                      onClick={() => void onDeleteTranslationMemory(idx)}
                    >
                      Remove
                    </button>
                  </div>
                ))
              ) : (
                <div className="trainModalEmpty">No training data yet.</div>
              )}
            </div>

            <div className="trainModalFooter">
              {memoryHint ? <span className="editHint">{memoryHint}</span> : <span />}
              <button
                type="button"
                className="btn primary"
                disabled={!trainDirty}
                onClick={() => void onSaveTrainingMemory()}
              >
                Save changes
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <footer className="footer">
        <span>{fileLabel ? `Loaded: ${fileLabel}` : 'No file loaded'}</span>
        <span className="sep">·</span>
        <span>{cues.length ? `${cues.length} cues` : ''}</span>
      </footer>
    </div>
  )
}

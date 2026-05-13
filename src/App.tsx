import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  PaintBucket,
  PaintRoller,
  Pilcrow,
  Plus,
  Printer,
  Redo2,
  Underline,
  Undo2,
} from 'lucide-react'
import { createEditorExtensions } from './editor/extensions'
import type { TagSuggestionItem } from './editor/tagSuggestion'
import {
  clearSyncBuffer,
  createNote,
  extractNotePreview,
  findTagResults,
  formatNoteDate,
  getTagSummaries,
  loadNotes,
  loadSyncBuffer,
  saveNotes,
  saveSyncBuffer,
  type Note,
  type TagResult,
} from './lib/notes'
import {
  createShloka,
  formatShlokaTags,
  getShlokaTagSummaries,
  loadShlokas,
  matchesShlokaSearch,
  parseShlokaTags,
  saveShlokas,
  type Shloka,
  type ShlokaStatus,
} from './lib/shlokas'
import {
  ensureSupabaseUser,
  fetchCloudNotes,
  subscribeToCloudNotes,
  syncCloudNotes,
} from './lib/supabase'
import { normalizeTag } from './lib/tags'
import './App.css'

type PendingTagFocus = {
  noteId: string
  tagId: string
  occurrenceIndex: number
  location: TagResult['location']
  contentOccurrenceIndex?: number
  titleRangeStart?: number
  titleRangeEnd?: number
  requestId: number
}

type PageView = 'editor' | 'notes' | 'tags' | 'shlokas'
type SaveState = 'saved' | 'saving' | 'error' | 'sync' | 'offline'

const FONT_FAMILIES = [
  { label: 'Aptos Sans', value: 'Aptos, Manrope, sans-serif' },
  { label: 'Manrope', value: 'Manrope, sans-serif' },
  { label: 'Newsreader', value: '"Newsreader", serif' },
  { label: 'IBM Plex Sans', value: '"IBM Plex Sans", sans-serif' },
  { label: 'Source Serif 4', value: '"Source Serif 4", serif' },
]

const FONT_SIZES = ['12px', '14px', '15px', '16px', '18px', '20px', '24px', '30px']
const LINE_HEIGHTS = [
  { label: 'Single', value: '1.15' },
  { label: 'Comfort', value: '1.5' },
  { label: 'Relaxed', value: '1.75' },
  { label: 'Spacious', value: '2' },
]

const TEXT_COLORS = ['#1f2328', '#5f6368', '#0b57d0', '#196c2e', '#b3261e', '#7c4dff']
const HIGHLIGHT_COLORS = ['#fff59d', '#ffd9a8', '#b9f6ca', '#d7efff', '#f0d9ff', '#ffd6e7']
const PARAGRAPH_STYLES = [{ label: 'Normal text', value: 'paragraph' }]
const SAVE_DEBOUNCE_MS = 450
const RETRY_DELAY_MS = 2500

function getOnlineStatus() {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

function App() {
  const [notes, setNotes] = useState<Note[]>(() =>
    typeof window === 'undefined' ? [] : loadNotes(),
  )
  const [shlokas, setShlokas] = useState<Shloka[]>(() =>
    typeof window === 'undefined' ? [] : loadShlokas(),
  )
  const [activeNoteId, setActiveNoteId] = useState('')
  const [currentPage, setCurrentPage] = useState<PageView>('editor')
  const [tagSearch, setTagSearch] = useState('')
  const [selectedTagId, setSelectedTagId] = useState('')
  const [shlokaSearch, setShlokaSearch] = useState('')
  const [selectedShlokaTagId, setSelectedShlokaTagId] = useState('')
  const [editingShlokaId, setEditingShlokaId] = useState('')
  const [shlokaText, setShlokaText] = useState('')
  const [shlokaTagsInput, setShlokaTagsInput] = useState('')
  const [shlokaStatus, setShlokaStatus] = useState<ShlokaStatus>('memorizing')
  const [pendingTagFocus, setPendingTagFocus] = useState<PendingTagFocus | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('sync')
  const [saveMessage, setSaveMessage] = useState('Connecting to Supabase…')
  const [cloudUserId, setCloudUserId] = useState('')
  const [isCloudReady, setIsCloudReady] = useState(false)
  const [isOnline, setIsOnline] = useState(getOnlineStatus)
  const notesRef = useRef(notes)
  const hasPendingSaveRef = useRef(false)
  const cloudSyncTimeoutRef = useRef<number | null>(null)
  const retryTimeoutRef = useRef<number | null>(null)
  const skipNextCloudSyncRef = useRef(false)
  const cloudUserIdRef = useRef('')
  const syncInFlightRef = useRef(false)
  const flushPendingSyncRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  useEffect(() => {
    cloudUserIdRef.current = cloudUserId
  }, [cloudUserId])

  useEffect(() => {
    saveNotes(notes)
  }, [notes])

  useEffect(() => {
    saveShlokas(shlokas)
  }, [shlokas])

  const clearSyncTimers = useCallback(() => {
    if (cloudSyncTimeoutRef.current) {
      window.clearTimeout(cloudSyncTimeoutRef.current)
      cloudSyncTimeoutRef.current = null
    }

    if (retryTimeoutRef.current) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }
  }, [])

  const persistPendingBuffer = useCallback((nextNotes: Note[]) => {
    const result = saveSyncBuffer({
      notes: nextNotes,
      updatedAt: new Date().toISOString(),
    })

    if (!result.ok) {
      setSaveState('error')
      setSaveMessage(`Sync buffer failed: ${result.error}`)
      return false
    }

    return true
  }, [])

  const applyLocalNotes = useCallback(
    (nextNotes: Note[], options?: { queueCloudSync?: boolean; message?: string }) => {
      setNotes(nextNotes)
      setActiveNoteId((currentActiveId) =>
        nextNotes.some((note) => note.id === currentActiveId) ? currentActiveId : nextNotes[0]?.id ?? '',
      )

      if (options?.queueCloudSync) {
        hasPendingSaveRef.current = true
        persistPendingBuffer(nextNotes)
        setSaveState(getOnlineStatus() ? 'saving' : 'offline')
        setSaveMessage(
          options.message ??
            (getOnlineStatus()
              ? 'Syncing local notes to Supabase…'
              : 'Offline. Changes are queued and will sync when you reconnect.'),
        )
        return
      }

      setSaveState('saved')
      setSaveMessage('Loaded local notes.')
    },
    [persistPendingBuffer],
  )

  const flushPendingSync = useCallback(async () => {
    if (!cloudUserIdRef.current || !notesRef.current.length || !getOnlineStatus()) {
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    syncInFlightRef.current = true
    const snapshot = notesRef.current
    const syncResult = await syncCloudNotes(cloudUserIdRef.current, snapshot)
    syncInFlightRef.current = false

    if (syncResult.ok) {
      clearSyncBuffer()
      hasPendingSaveRef.current = false
      setSaveState('saved')
      setSaveMessage('All changes saved to Supabase.')
      return
    }

    hasPendingSaveRef.current = true
    persistPendingBuffer(snapshot)
    setSaveState(getOnlineStatus() ? 'error' : 'offline')
    setSaveMessage(
      getOnlineStatus()
        ? `Sync failed. Retrying… ${syncResult.error}`
        : 'Offline. Changes are queued and will sync when you reconnect.',
    )

    clearSyncTimers()
    retryTimeoutRef.current = window.setTimeout(() => {
      void flushPendingSyncRef.current()
    }, RETRY_DELAY_MS)
  }, [clearSyncTimers, persistPendingBuffer])

  useEffect(() => {
    flushPendingSyncRef.current = flushPendingSync
  }, [flushPendingSync])

  useEffect(() => {
    let isCancelled = false

    async function initializeCloudSync() {
      setSaveState('sync')
      setSaveMessage('Connecting to Supabase…')

      const pendingBuffer = loadSyncBuffer()
      const localNotes = loadNotes()

      const authResult = await ensureSupabaseUser()

      if (isCancelled) {
        return
      }

      if (!authResult.ok) {
        if (pendingBuffer?.notes.length) {
          applyLocalNotes(pendingBuffer.notes, {
            queueCloudSync: true,
            message: 'Supabase unavailable. Using queued local changes.',
          })
          setIsCloudReady(true)
          return
        }

        if (localNotes.length) {
          applyLocalNotes(localNotes)
          setIsCloudReady(true)
          setSaveState('error')
          setSaveMessage(`Supabase unavailable: ${authResult.error}. Loaded local notes.`)
          return
        }

        setSaveState('error')
        setSaveMessage(`Supabase unavailable: ${authResult.error}`)
        return
      }

      const userId = authResult.data.id
      setCloudUserId(userId)

      const remoteResult = await fetchCloudNotes(userId)

      if (isCancelled) {
        return
      }

      if (!remoteResult.ok) {
        if (pendingBuffer?.notes.length) {
          applyLocalNotes(pendingBuffer.notes, {
            queueCloudSync: true,
            message: getOnlineStatus()
              ? 'Reconnecting and syncing queued changes…'
              : 'Offline. Changes are queued and will sync when you reconnect.',
          })
          setIsCloudReady(true)
          return
        }

        if (localNotes.length) {
          applyLocalNotes(localNotes)
          setIsCloudReady(true)
          setSaveState('error')
          setSaveMessage(`Supabase load failed: ${remoteResult.error}. Loaded local notes.`)
          setIsCloudReady(true)
          return
        }

        setSaveState('error')
        setSaveMessage(`Supabase load failed: ${remoteResult.error}`)
        return
      }

      const remoteNotes = remoteResult.data

      if (pendingBuffer?.notes.length) {
        applyLocalNotes(pendingBuffer.notes, {
          queueCloudSync: true,
          message: getOnlineStatus()
            ? 'Syncing queued changes to Supabase…'
            : 'Offline. Changes are queued and will sync when you reconnect.',
        })
        setIsCloudReady(true)
        return
      }

      if (!remoteNotes.length && localNotes.length) {
        applyLocalNotes(localNotes, {
          queueCloudSync: true,
          message: getOnlineStatus()
            ? 'Restoring your local notes to Supabase…'
            : 'Offline. Local notes restored and queued for sync.',
        })
        setIsCloudReady(true)
        return
      }

      if (!remoteNotes.length) {
        const firstNote = createNote()
        applyLocalNotes([firstNote], {
          queueCloudSync: true,
          message: getOnlineStatus()
            ? 'Saving your first note to Supabase…'
            : 'Offline. Changes are queued and will sync when you reconnect.',
        })
        setIsCloudReady(true)
        return
      }

      skipNextCloudSyncRef.current = true
      setNotes(remoteNotes)
      setActiveNoteId(remoteNotes[0]?.id ?? '')
      setSaveState('saved')
      setSaveMessage('All changes saved to Supabase.')
      setIsCloudReady(true)
    }

    void initializeCloudSync()

    return () => {
      isCancelled = true
      clearSyncTimers()
    }
  }, [applyLocalNotes, clearSyncTimers, flushPendingSync, persistPendingBuffer])

  useEffect(() => {
    if (!cloudUserId) {
      return
    }

    return subscribeToCloudNotes(cloudUserId, async () => {
      if (hasPendingSaveRef.current) {
        return
      }

      const remoteResult = await fetchCloudNotes(cloudUserId)

      if (!remoteResult.ok) {
        setSaveState('error')
        setSaveMessage(`Supabase sync failed: ${remoteResult.error}`)
        return
      }

      if (!remoteResult.data.length && notesRef.current.length) {
        hasPendingSaveRef.current = true
        persistPendingBuffer(notesRef.current)
        setSaveState(getOnlineStatus() ? 'saving' : 'offline')
        setSaveMessage(
          getOnlineStatus()
            ? 'Supabase returned an empty notebook. Keeping local notes and re-syncing…'
            : 'Offline. Local notes are preserved and queued for sync.',
        )
        return
      }

      skipNextCloudSyncRef.current = true
      setNotes(remoteResult.data)
      setActiveNoteId((currentActiveId) =>
        remoteResult.data.some((note) => note.id === currentActiveId)
          ? currentActiveId
          : remoteResult.data[0]?.id ?? '',
      )
      setSaveState('saved')
      setSaveMessage('All changes saved to Supabase.')
    })
  }, [cloudUserId, persistPendingBuffer])

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)

      if (!hasPendingSaveRef.current) {
        setSaveState('saved')
        setSaveMessage('Back online. All changes saved to Supabase.')
        return
      }

      setSaveState('saving')
      setSaveMessage('Back online. Syncing queued changes…')
      void flushPendingSync()
    }

    const handleOffline = () => {
      setIsOnline(false)

      if (hasPendingSaveRef.current) {
        setSaveState('offline')
        setSaveMessage('Offline. Changes are queued and will sync when you reconnect.')
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && getOnlineStatus() && hasPendingSaveRef.current) {
        void flushPendingSync()
      }
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushPendingSync])

  useEffect(() => {
    const handlePageExit = () => {
      if (hasPendingSaveRef.current) {
        persistPendingBuffer(notesRef.current)
      }

      if (getOnlineStatus() && hasPendingSaveRef.current) {
        void flushPendingSync()
      }
    }

    window.addEventListener('pagehide', handlePageExit)
    window.addEventListener('beforeunload', handlePageExit)

    return () => {
      window.removeEventListener('pagehide', handlePageExit)
      window.removeEventListener('beforeunload', handlePageExit)
    }
  }, [flushPendingSync, persistPendingBuffer])

  useEffect(() => {
    if (!cloudUserId) {
      return
    }

    if (skipNextCloudSyncRef.current) {
      skipNextCloudSyncRef.current = false
      return
    }

    if (!notes.length) {
      return
    }

    hasPendingSaveRef.current = true
    if (!persistPendingBuffer(notesRef.current)) {
      return
    }

    clearSyncTimers()

    if (!isOnline) {
      setSaveState('offline')
      setSaveMessage('Offline. Changes are queued and will sync when you reconnect.')
      return
    }

    setSaveState('saving')
    setSaveMessage('Saving changes to Supabase…')

    cloudSyncTimeoutRef.current = window.setTimeout(async () => {
      await flushPendingSync()
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (cloudSyncTimeoutRef.current) {
        window.clearTimeout(cloudSyncTimeoutRef.current)
        cloudSyncTimeoutRef.current = null
      }
    }
  }, [clearSyncTimers, cloudUserId, flushPendingSync, isOnline, notes, persistPendingBuffer])

  const activeNote = notes.find((note) => note.id === activeNoteId) ?? notes[0]
  const tagSummaries = getTagSummaries(notes)
  const shlokaTagSummaries = getShlokaTagSummaries(shlokas)
  const tagSuggestionItems: TagSuggestionItem[] = tagSummaries.map((tag) => ({
    id: tag.id,
    label: tag.label,
  }))
  const effectiveSelectedTagId = tagSummaries.some((tag) => tag.id === selectedTagId)
    ? selectedTagId
    : ''
  const normalizedSearch = normalizeTag(tagSearch)
  const searchTerm = tagSearch.trim().replace(/^#+/, '').toLowerCase()
  const visibleTags = tagSummaries
    .filter((tag) => {
      if (!normalizedSearch) {
        return true
      }

      return tag.id.includes(normalizedSearch) || tag.label.toLowerCase().includes(searchTerm)
    })
    .sort((left, right) => {
      if (!normalizedSearch) {
        return left.label.localeCompare(right.label)
      }

      const leftLabel = left.label.toLowerCase()
      const rightLabel = right.label.toLowerCase()
      const leftStarts = left.id.startsWith(normalizedSearch) || leftLabel.startsWith(searchTerm)
      const rightStarts =
        right.id.startsWith(normalizedSearch) || rightLabel.startsWith(searchTerm)

      if (leftStarts !== rightStarts) {
        return leftStarts ? -1 : 1
      }

      return left.label.localeCompare(right.label)
    })
  const tagSearchSuggestions = visibleTags.slice(0, 8)
  const activeTagId = effectiveSelectedTagId || tagSearchSuggestions[0]?.id || ''
  const activeTagResults = activeTagId ? findTagResults(notes, activeTagId) : []
  const activeTagLabel = tagSummaries.find((tag) => tag.id === activeTagId)?.label ?? activeTagId
  const pendingTagLabel = pendingTagFocus
    ? tagSummaries.find((tag) => tag.id === pendingTagFocus.tagId)?.label ?? pendingTagFocus.tagId
    : ''
  const activeTagResultPosition = pendingTagFocus
    ? activeTagResults.findIndex((result) => isMatchingTagResult(result, pendingTagFocus))
    : -1

  const hasNoTagMatches = Boolean(normalizedSearch) && !tagSearchSuggestions.length
  const shouldShowSuggestionList = Boolean(normalizedSearch)
  const normalizedShlokaSearch = normalizeTag(shlokaSearch)
  const shlokaSearchTerm = shlokaSearch.trim().replace(/^#+/, '').toLowerCase()
  const visibleShlokaTags = shlokaTagSummaries
    .filter((tag) => {
      if (!normalizedShlokaSearch) {
        return true
      }

      return (
        tag.id.includes(normalizedShlokaSearch) ||
        tag.label.toLowerCase().includes(shlokaSearchTerm)
      )
    })
    .sort((left, right) => left.label.localeCompare(right.label))
  const shlokaSearchSuggestions = visibleShlokaTags.slice(0, 8)
  const activeShlokaTagId = shlokaTagSummaries.some((tag) => tag.id === selectedShlokaTagId)
    ? selectedShlokaTagId
    : ''
  const effectiveShlokaTagId = activeShlokaTagId || shlokaSearchSuggestions[0]?.id || ''
  const filteredShlokas = shlokas
    .filter((shloka) => {
      const tagMatches = effectiveShlokaTagId ? shloka.tags.includes(effectiveShlokaTagId) : true
      const textMatches = normalizedShlokaSearch
        ? matchesShlokaSearch(shloka, shlokaSearchTerm)
        : true

      return tagMatches && textMatches
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const memorizedShlokas = filteredShlokas.filter((shloka) => shloka.status === 'memorized')
  const memorizingShlokas = filteredShlokas.filter((shloka) => shloka.status === 'memorizing')
  const hasNoShlokaTagMatches =
    Boolean(normalizedShlokaSearch) && !shlokaSearchSuggestions.length && !filteredShlokas.length

  function updateCurrentNote(patch: Partial<Pick<Note, 'title' | 'content'>>) {
    setSaveState('saving')
    setSaveMessage('Syncing to Supabase…')
    setNotes((currentNotes) =>
      currentNotes.map((note) =>
        note.id === activeNoteId
          ? {
              ...note,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
          : note,
      ),
    )
  }

  function resetShlokaForm() {
    setEditingShlokaId('')
    setShlokaText('')
    setShlokaTagsInput('')
    setShlokaStatus('memorizing')
  }

  function editShloka(shloka: Shloka) {
    setEditingShlokaId(shloka.id)
    setShlokaText(shloka.text)
    setShlokaTagsInput(formatShlokaTags(shloka.tags))
    setShlokaStatus(shloka.status)
    setCurrentPage('shlokas')
  }

  function handleSaveShloka() {
    const trimmedText = shlokaText.trim()
    const nextTags = parseShlokaTags(shlokaTagsInput)

    if (!trimmedText) {
      return
    }

    const now = new Date().toISOString()

    if (editingShlokaId) {
      setShlokas((currentShlokas) =>
        currentShlokas.map((shloka) =>
          shloka.id === editingShlokaId
            ? {
                ...shloka,
                title: '',
                reference: '',
                text: trimmedText,
                tags: nextTags,
                status: shlokaStatus,
                updatedAt: now,
              }
            : shloka,
        ),
      )
    } else {
      const newShloka = createShloka()
      setShlokas((currentShlokas) => [
        {
          ...newShloka,
          title: '',
          reference: '',
          text: trimmedText,
          tags: nextTags,
          status: shlokaStatus,
          updatedAt: now,
        },
        ...currentShlokas,
      ])
    }

    resetShlokaForm()
  }

  function handleDeleteShloka(shlokaId: string) {
    setShlokas((currentShlokas) => currentShlokas.filter((shloka) => shloka.id !== shlokaId))

    if (editingShlokaId === shlokaId) {
      resetShlokaForm()
    }
  }

  function handleShlokaTagSelection(tagId: string) {
    setSelectedShlokaTagId(tagId)
    setShlokaSearch(tagId)
  }

  function handleCreateNote() {
    const newNote = createNote()
    setSaveState('saving')
    setSaveMessage('Syncing to Supabase…')
    setNotes((currentNotes) => [newNote, ...currentNotes])
    setActiveNoteId(newNote.id)
    setPendingTagFocus(null)
    setCurrentPage('editor')
  }

  function handleDeleteNote(noteId: string) {
    if (notes.length === 1) {
      const freshNote = createNote()
      setSaveState('saving')
      setSaveMessage('Syncing to Supabase…')
      setNotes([freshNote])
      setActiveNoteId(freshNote.id)
      setPendingTagFocus(null)
      return
    }

    setSaveState('saving')
    setSaveMessage('Syncing to Supabase…')
    setNotes((currentNotes) => currentNotes.filter((note) => note.id !== noteId))

    if (activeNoteId === noteId) {
      const fallback = notes.find((note) => note.id !== noteId)
      if (fallback) {
        setActiveNoteId(fallback.id)
      }
    }
  }

  function handleTagSelection(tagId: string, tagLabel?: string) {
    setSelectedTagId(tagId)
    setTagSearch(tagLabel ?? tagSummaries.find((tag) => tag.id === tagId)?.label ?? tagId)
  }

  function handleSearchSubmit() {
    if (tagSearchSuggestions[0]) {
      handleTagSelection(tagSearchSuggestions[0].id, tagSearchSuggestions[0].label)
    }
  }

  function openNoteInEditor(noteId: string) {
    setActiveNoteId(noteId)
    setPendingTagFocus(null)
    setCurrentPage('editor')
  }

  function jumpToTagOccurrence(direction: 'previous' | 'next') {
    if (!pendingTagFocus || !activeTagResults.length) {
      return
    }

    const currentIndex = activeTagResultPosition >= 0 ? activeTagResultPosition : 0
    const nextIndex =
      direction === 'next'
        ? (currentIndex + 1) % activeTagResults.length
        : (currentIndex + activeTagResults.length - 1) % activeTagResults.length
    const nextOccurrence = activeTagResults[nextIndex]

    if (!nextOccurrence) {
      return
    }

    setActiveNoteId(nextOccurrence.noteId)
    setPendingTagFocus(createPendingTagFocus(nextOccurrence))
  }

  if (!isCloudReady || !activeNote) {
    return (
      <div className="app-shell">
        <main className="workspace">
          <div className="docs-chrome">
            <nav className="workspace-nav" aria-label="Section navigation">
              <button className="workspace-nav-link active" type="button">
                <span>Editor</span>
              </button>
              <button className="workspace-nav-link" type="button">
                <span>Notes</span>
              </button>
              <button className="workspace-nav-link" type="button">
                <span>Tag Search</span>
              </button>
              <button className="workspace-nav-link" type="button">
                <span>Shlokas</span>
              </button>
              <span className={`workspace-save-state ${saveState}`}>{saveMessage}</span>
            </nav>

            <section className="workspace-page">
              <div className="page-shell">
                <section className="sidebar-panel page-panel">
                  <div className="panel-heading">
                    <h2>Supabase</h2>
                  </div>
                  <p>{saveMessage}</p>
                </section>
              </div>
            </section>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <main className="workspace">
        <div className="docs-chrome">
          <nav className="workspace-nav" aria-label="Section navigation">
            <button
              className={`workspace-nav-link${currentPage === 'editor' ? ' active' : ''}`}
              onClick={() => setCurrentPage('editor')}
              type="button"
            >
              <span>Editor</span>
            </button>
            <button
              className={`workspace-nav-link${currentPage === 'notes' ? ' active' : ''}`}
              onClick={() => setCurrentPage('notes')}
              type="button"
            >
              <span>Notes</span>
            </button>
            <button
              className={`workspace-nav-link${currentPage === 'tags' ? ' active' : ''}`}
              onClick={() => setCurrentPage('tags')}
              type="button"
            >
              <span>Tag Search</span>
            </button>
            <button
              className={`workspace-nav-link${currentPage === 'shlokas' ? ' active' : ''}`}
              onClick={() => setCurrentPage('shlokas')}
              type="button"
            >
              <span>Shlokas</span>
            </button>
            <span className={`workspace-save-state ${saveState}`}>{saveMessage}</span>
          </nav>

          {currentPage === 'editor' ? (
            <EditorPanel
              note={activeNote}
              onContentChange={(content) => updateCurrentNote({ content })}
              onTitleChange={(title) => updateCurrentNote({ title })}
              pendingTagFocus={pendingTagFocus}
              onJumpToNext={() => jumpToTagOccurrence('next')}
              onJumpToPrevious={() => jumpToTagOccurrence('previous')}
              tagJumpLabel={pendingTagLabel}
              tagJumpPosition={activeTagResultPosition >= 0 ? activeTagResultPosition + 1 : 0}
              tagJumpTotal={activeTagResults.length}
              tagSuggestions={tagSuggestionItems}
            />
          ) : null}

          {currentPage === 'notes' ? (
            <section className="workspace-page">
              <div className="page-shell">
                <section className="sidebar-panel page-panel">
                  <div className="panel-heading">
                    <h2>Notes</h2>
                    <div className="panel-heading-actions">
                      <span>{notes.length}</span>
                      <button className="primary-button" onClick={handleCreateNote} type="button">
                        New note
                      </button>
                    </div>
                  </div>
                  <div className="note-list">
                    {notes.map((note) => {
                      const isActive = note.id === activeNoteId

                      return (
                        <article
                          key={note.id}
                          className={`note-card${isActive ? ' active' : ''}`}
                          onClick={() => openNoteInEditor(note.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openNoteInEditor(note.id)
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="note-card-row">
                            <strong>{note.title || 'Untitled note'}</strong>
                            <button
                              className="ghost-button note-delete"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleDeleteNote(note.id)
                              }}
                              type="button"
                            >
                              Delete
                            </button>
                          </div>
                          <p>{extractNotePreview(note.content)}</p>
                          <span>{formatNoteDate(note.updatedAt)}</span>
                        </article>
                      )
                    })}
                  </div>
                </section>
              </div>
            </section>
          ) : null}

          {currentPage === 'tags' ? (
            <section className="workspace-page">
              <div className="page-shell">
                <section className="sidebar-panel page-panel">
                  <div className="panel-heading">
                    <h2>Tag Search</h2>
                    <span>{tagSummaries.length}</span>
                  </div>
                  <label className="search-input">
                    <span>#</span>
                    <input
                      onChange={(event) => {
                        setTagSearch(event.target.value)
                        setSelectedTagId('')
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          handleSearchSubmit()
                        }
                      }}
                      placeholder="Search saved tags"
                      type="text"
                      value={tagSearch}
                    />
                  </label>

                  {shouldShowSuggestionList && tagSearchSuggestions.length ? (
                    <div className="search-suggestion-list" role="listbox" aria-label="Tag suggestions">
                      {tagSearchSuggestions.map((tag) => (
                        <button
                          key={tag.id}
                          className={`search-suggestion-item${activeTagId === tag.id ? ' active' : ''}`}
                          onClick={() => {
                            handleTagSelection(tag.id, tag.label)
                          }}
                          type="button"
                        >
                          <strong>#{tag.label}</strong>
                          <span>{tag.count} matches</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {hasNoTagMatches ? (
                    <div className="search-empty-state">No saved tags match this search.</div>
                  ) : null}

                  <div className="tag-list">
                    {visibleTags.slice(0, 18).map((tag) => (
                      <button
                        key={tag.id}
                        className={`tag-row${activeTagId === tag.id ? ' active' : ''}`}
                        onClick={() => handleTagSelection(tag.id, tag.label)}
                        type="button"
                      >
                        <span>#{tag.label}</span>
                        <small>{tag.count}</small>
                      </button>
                    ))}
                  </div>

                  {activeTagId ? (
                    <div className="tag-results">
                      <div className="tag-results-header">
                        <strong>#{activeTagLabel}</strong>
                        <span>{activeTagResults.length}</span>
                      </div>
                      {activeTagResults.map((result) => (
                        <button
                          key={`${result.noteId}-${result.tagId}-${result.occurrenceIndex}`}
                          className="result-card"
                          onClick={() => {
                            setActiveNoteId(result.noteId)
                            setPendingTagFocus(createPendingTagFocus(result))
                            setCurrentPage('editor')
                          }}
                          type="button"
                        >
                          <strong>{result.noteTitle}</strong>
                          <p>{result.snippet}</p>
                          <span>{formatNoteDate(result.updatedAt)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              </div>
            </section>
          ) : null}

          {currentPage === 'shlokas' ? (
            <section className="workspace-page">
              <div className="page-shell shloka-layout">
                <section className="sidebar-panel page-panel shloka-form-panel">
                  <div className="panel-heading">
                    <h2>{editingShlokaId ? 'Edit shloka' : 'Shloka repository'}</h2>
                    <div className="panel-heading-actions">
                      <span>{shlokas.length}</span>
                      <button className="ghost-button" onClick={resetShlokaForm} type="button">
                        New
                      </button>
                    </div>
                  </div>

                  <label className="field-stack">
                    <span>Shloka text</span>
                    <textarea
                      className="shloka-textarea"
                      onChange={(event) => setShlokaText(event.target.value)}
                      placeholder="Paste the full shloka or lecture-ready excerpt here."
                      rows={8}
                      value={shlokaText}
                    />
                  </label>

                  <label className="field-stack">
                    <span>Whole-shloka tags</span>
                    <input
                      className="shloka-input"
                      onChange={(event) => setShlokaTagsInput(event.target.value)}
                      placeholder="#mercifulness #compassion #bhagavad-gita"
                      type="text"
                      value={shlokaTagsInput}
                    />
                  </label>

                  <label className="field-stack">
                    <span>Memory basket</span>
                    <select
                      className="toolbar-select shloka-select"
                      onChange={(event) => setShlokaStatus(event.target.value as ShlokaStatus)}
                      value={shlokaStatus}
                    >
                      <option value="memorizing">Memorizing</option>
                      <option value="memorized">Memorized</option>
                    </select>
                  </label>

                  <div className="shloka-form-actions">
                    <button className="primary-button" onClick={handleSaveShloka} type="button">
                      {editingShlokaId ? 'Update shloka' : 'Save shloka'}
                    </button>
                    {editingShlokaId ? (
                      <button className="ghost-button" onClick={resetShlokaForm} type="button">
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </section>

                <section className="sidebar-panel page-panel">
                  <div className="panel-heading">
                    <h2>Browse by tag</h2>
                    <span>{filteredShlokas.length} shown</span>
                  </div>

                  <label className="search-input">
                    <span>#</span>
                    <input
                      onChange={(event) => {
                        setShlokaSearch(event.target.value)
                        setSelectedShlokaTagId('')
                      }}
                      placeholder="Search shlokas or tags"
                      type="text"
                      value={shlokaSearch}
                    />
                  </label>

                  {Boolean(normalizedShlokaSearch) && shlokaSearchSuggestions.length ? (
                    <div className="search-suggestion-list" role="listbox" aria-label="Shloka tag suggestions">
                      {shlokaSearchSuggestions.map((tag) => (
                        <button
                          key={tag.id}
                          className={`search-suggestion-item${effectiveShlokaTagId === tag.id ? ' active' : ''}`}
                          onClick={() => handleShlokaTagSelection(tag.id)}
                          type="button"
                        >
                          <strong>#{tag.label}</strong>
                          <span>{tag.count} shlokas</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {hasNoShlokaTagMatches ? (
                    <div className="search-empty-state">No saved shloka tags match this search.</div>
                  ) : null}

                  <div className="tag-list">
                    {visibleShlokaTags.map((tag) => (
                      <button
                        key={tag.id}
                        className={`tag-row${effectiveShlokaTagId === tag.id ? ' active' : ''}`}
                        onClick={() => handleShlokaTagSelection(tag.id)}
                        type="button"
                      >
                        <span>#{tag.label}</span>
                        <small>{tag.count}</small>
                      </button>
                    ))}
                  </div>

                  <div className="shloka-baskets">
                    <div className="tag-results">
                      <div className="tag-results-header">
                        <strong>Memorizing</strong>
                        <span>{memorizingShlokas.length}</span>
                      </div>
                      {memorizingShlokas.length ? (
                        memorizingShlokas.map((shloka) => (
                          <ShlokaCard
                            key={shloka.id}
                            onDelete={handleDeleteShloka}
                            onEdit={editShloka}
                            onTagClick={handleShlokaTagSelection}
                            shloka={shloka}
                          />
                        ))
                      ) : (
                        <div className="search-empty-state">No shlokas in the memorizing basket.</div>
                      )}
                    </div>

                    <div className="tag-results">
                      <div className="tag-results-header">
                        <strong>Memorized</strong>
                        <span>{memorizedShlokas.length}</span>
                      </div>
                      {memorizedShlokas.length ? (
                        memorizedShlokas.map((shloka) => (
                          <ShlokaCard
                            key={shloka.id}
                            onDelete={handleDeleteShloka}
                            onEdit={editShloka}
                            onTagClick={handleShlokaTagSelection}
                            shloka={shloka}
                          />
                        ))
                      ) : (
                        <div className="search-empty-state">No shlokas in the memorized basket.</div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  )
}

type EditorPanelProps = {
  note: Note
  onContentChange: (content: JSONContent) => void
  onTitleChange: (title: string) => void
  pendingTagFocus: PendingTagFocus | null
  onJumpToNext: () => void
  onJumpToPrevious: () => void
  tagJumpLabel: string
  tagJumpPosition: number
  tagJumpTotal: number
  tagSuggestions: TagSuggestionItem[]
}

function EditorPanel({
  note,
  onContentChange,
  onTitleChange,
  pendingTagFocus,
  onJumpToNext,
  onJumpToPrevious,
  tagJumpLabel,
  tagJumpPosition,
  tagJumpTotal,
  tagSuggestions,
}: EditorPanelProps) {
  const activeNoteRef = useRef(note.id)
  const highlightedTagElementRef = useRef<HTMLElement | null>(null)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const isTitleJumpTarget =
    pendingTagFocus?.noteId === note.id && pendingTagFocus.location === 'title'
  const [tagSuggestionStore] = useState(() => ({
    items: tagSuggestions,
    getItems() {
      return this.items
    },
    setItems(nextItems: TagSuggestionItem[]) {
      this.items = nextItems
    },
  }))
  const [extensions] = useState(() =>
    createEditorExtensions(() => tagSuggestionStore.getItems()),
  )

  useEffect(() => {
    tagSuggestionStore.setItems(tagSuggestions)
  }, [tagSuggestionStore, tagSuggestions])

  const editor = useEditor({
    extensions,
    content: note.content,
    editorProps: {
      attributes: {
        class: 'note-editor',
      },
    },
    immediatelyRender: true,
  })

  useEffect(() => {
    if (!editor) {
      return
    }

    const handleUpdate = () => {
      onContentChange(editor.getJSON())
    }

    editor.on('update', handleUpdate)

    return () => {
      editor.off('update', handleUpdate)
    }
  }, [editor, onContentChange])

  useEffect(() => {
    if (!editor) {
      return
    }

    if (activeNoteRef.current === note.id) {
      return
    }

    editor.commands.setContent(note.content, { emitUpdate: false })
    editor.commands.focus('end')
    activeNoteRef.current = note.id
  }, [editor, note.content, note.id])

  useEffect(() => {
    const clearHighlightedTag = () => {
      if (highlightedTagElementRef.current) {
        highlightedTagElementRef.current.classList.remove('is-jump-target')
        highlightedTagElementRef.current = null
      }
    }

    if (!editor || !pendingTagFocus || pendingTagFocus.noteId !== note.id) {
      clearHighlightedTag()
      return
    }

    if (pendingTagFocus.location === 'title') {
      clearHighlightedTag()
      const titleInput = titleInputRef.current

      if (titleInput) {
        titleInput.focus()
        if (
          typeof pendingTagFocus.titleRangeStart === 'number' &&
          typeof pendingTagFocus.titleRangeEnd === 'number'
        ) {
          titleInput.setSelectionRange(
            pendingTagFocus.titleRangeStart,
            pendingTagFocus.titleRangeEnd,
          )
        }
        titleInput.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'nearest',
        })
      }

      return
    }

    let currentOccurrence = 0
    let selection: { from: number; to: number } | null = null

    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tag' && node.attrs.id === pendingTagFocus.tagId) {
        currentOccurrence += 1

        if (currentOccurrence === pendingTagFocus.contentOccurrenceIndex) {
          selection = { from: position, to: position + node.nodeSize }
          return false
        }
      }

      return true
    })

    if (selection) {
      editor.chain().focus().setTextSelection(selection).run()
    }

    clearHighlightedTag()

    const tagElements = Array.from(
      editor.view.dom.querySelectorAll(`.tag-token[data-tag-id="${pendingTagFocus.tagId}"]`),
    ) as HTMLElement[]
    const targetElement = tagElements[(pendingTagFocus.contentOccurrenceIndex ?? 1) - 1]

    if (targetElement) {
      targetElement.classList.add('is-jump-target')
      highlightedTagElementRef.current = targetElement
      targetElement.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      })
    }

    return () => {
      clearHighlightedTag()
    }
  }, [editor, note.id, pendingTagFocus])

  const editorState = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor) {
        return {
          canUndo: false,
          canRedo: false,
          isBold: false,
          isItalic: false,
          isUnderline: false,
          isBullet: false,
          isOrdered: false,
          isChecklist: false,
          alignment: 'left',
          color: TEXT_COLORS[0],
          highlight: HIGHLIGHT_COLORS[0],
          fontFamily: FONT_FAMILIES[0].value,
          fontSize: '15px',
          lineHeight: '1.5',
        }
      }

      const textStyle = currentEditor.getAttributes('textStyle')
      const paragraph = currentEditor.getAttributes('paragraph')
      const heading = currentEditor.getAttributes('heading')
      const highlight = currentEditor.getAttributes('highlight')

      return {
        canUndo: currentEditor.can().undo(),
        canRedo: currentEditor.can().redo(),
        isBold: currentEditor.isActive('bold'),
        isItalic: currentEditor.isActive('italic'),
        isUnderline: currentEditor.isActive('underline'),
        isBullet: currentEditor.isActive('bulletList'),
        isOrdered: currentEditor.isActive('orderedList'),
        isChecklist: currentEditor.isActive('taskList'),
        alignment: paragraph.textAlign ?? heading.textAlign ?? 'left',
        color: textStyle.color ?? TEXT_COLORS[0],
        highlight: highlight.color ?? HIGHLIGHT_COLORS[0],
        fontFamily: textStyle.fontFamily ?? FONT_FAMILIES[0].value,
        fontSize: textStyle.fontSize ?? '15px',
        lineHeight: paragraph.lineHeight ?? heading.lineHeight ?? '1.5',
      }
    },
  })

  return (
    <section className="editor-panel">
      <div className="docs-toolbar-bar">
        <div className="toolbar-main">
          <div className="toolbar-group">
            <button
              aria-label="Undo"
              className="icon-button icon-only"
              disabled={!editorState?.canUndo}
              onClick={() => editor?.chain().focus().undo().run()}
              type="button"
            >
              <Undo2 size={18} />
            </button>
            <button
              aria-label="Redo"
              className="icon-button icon-only"
              disabled={!editorState?.canRedo}
              onClick={() => editor?.chain().focus().redo().run()}
              type="button"
            >
              <Redo2 size={18} />
            </button>
            <button aria-label="Print" className="icon-button icon-only" type="button">
              <Printer size={18} />
            </button>
            <button aria-label="Paint format" className="icon-button icon-only" type="button">
              <PaintRoller size={18} />
            </button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-pill" type="button">
              100%
              <ChevronDown size={16} />
            </button>
            <select className="toolbar-select compact-select" defaultValue="paragraph">
              {PARAGRAPH_STYLES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              className="toolbar-select"
              onChange={(event) =>
                editor?.chain().focus().setFontFamily(event.target.value).run()
              }
              value={editorState?.fontFamily}
            >
              {FONT_FAMILIES.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
            <div className="font-size-stepper">
              <button
                aria-label="Decrease font size"
                className="icon-button icon-only"
                onClick={() => {
                  if (!editorState?.fontSize) {
                    return
                  }

                  const currentIndex = FONT_SIZES.indexOf(editorState.fontSize)
                  const safeIndex = currentIndex === -1 ? 0 : currentIndex
                  const nextIndex = Math.max(0, safeIndex - 1)
                  editor?.chain().focus().setFontSize(FONT_SIZES[nextIndex]).run()
                }}
                type="button"
              >
                <Minus size={16} />
              </button>
              <select
                className="toolbar-select size-select"
                onChange={(event) =>
                  editor?.chain().focus().setFontSize(event.target.value).run()
                }
                value={editorState?.fontSize}
              >
                {FONT_SIZES.map((fontSize) => (
                  <option key={fontSize} value={fontSize}>
                    {fontSize.replace('px', '')}
                  </option>
                ))}
              </select>
              <button
                aria-label="Increase font size"
                className="icon-button icon-only"
                onClick={() => {
                  if (!editorState?.fontSize) {
                    return
                  }

                  const currentIndex = FONT_SIZES.indexOf(editorState.fontSize)
                  const safeIndex = currentIndex === -1 ? 0 : currentIndex
                  const nextIndex = Math.min(FONT_SIZES.length - 1, safeIndex + 1)
                  editor?.chain().focus().setFontSize(FONT_SIZES[nextIndex]).run()
                }}
                type="button"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>

          <div className="toolbar-group">
            <button
              aria-label="Bold"
              className={`icon-button icon-only${editorState?.isBold ? ' active' : ''}`}
              onClick={() => editor?.chain().focus().toggleBold().run()}
              type="button"
            >
              <Bold size={18} />
            </button>
            <button
              aria-label="Italic"
              className={`icon-button icon-only${editorState?.isItalic ? ' active' : ''}`}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              type="button"
            >
              <Italic size={18} />
            </button>
            <button
              aria-label="Underline"
              className={`icon-button icon-only${editorState?.isUnderline ? ' active' : ''}`}
              onClick={() => editor?.chain().focus().toggleUnderline().run()}
              type="button"
            >
              <Underline size={18} />
            </button>
          </div>

          <div className="toolbar-group color-group">
            <label className="color-field">
              <span>
                <PaintBucket size={17} />
              </span>
              <input
                onChange={(event) =>
                  editor?.chain().focus().setColor(event.target.value).run()
                }
                type="color"
                value={editorState?.color}
              />
            </label>
            <label className="color-field">
              <span>
                <Highlighter size={17} />
              </span>
              <input
                onChange={(event) =>
                  editor?.chain().focus().setHighlight({ color: event.target.value }).run()
                }
                type="color"
                value={editorState?.highlight}
              />
            </label>
          </div>

          <div className="toolbar-group">
            {['left', 'center', 'right', 'justify'].map((alignment) => (
              <button
                key={alignment}
                aria-label={`Align ${alignment}`}
                className={`icon-button icon-only${editorState?.alignment === alignment ? ' active' : ''}`}
                onClick={() => editor?.chain().focus().setTextAlign(alignment).run()}
                type="button"
              >
                {alignment === 'left' ? <AlignLeft size={18} /> : null}
                {alignment === 'center' ? <AlignCenter size={18} /> : null}
                {alignment === 'right' ? <AlignRight size={18} /> : null}
                {alignment === 'justify' ? <AlignJustify size={18} /> : null}
              </button>
            ))}
          </div>

          <div className="toolbar-group">
            <select
              className="toolbar-select compact-select"
              onChange={(event) =>
                editor?.chain().focus().setLineHeight(event.target.value).run()
              }
              value={editorState?.lineHeight}
            >
              {LINE_HEIGHTS.map((lineHeight) => (
                <option key={lineHeight.value} value={lineHeight.value}>
                  {lineHeight.label}
                </option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button
              aria-label="Bulleted list"
              className={`icon-button icon-only${editorState?.isBullet ? ' active' : ''}`}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              type="button"
            >
              <List size={18} />
            </button>
            <button
              aria-label="Numbered list"
              className={`icon-button icon-only${editorState?.isOrdered ? ' active' : ''}`}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              type="button"
            >
              <ListOrdered size={18} />
            </button>
            <button
              aria-label="Checklist"
              className={`icon-button icon-only${editorState?.isChecklist ? ' active' : ''}`}
              onClick={() => editor?.chain().focus().toggleTaskList().run()}
              type="button"
            >
              <ListChecks size={18} />
            </button>
          </div>

          <div className="toolbar-group">
            <button aria-label="Link" className="icon-button icon-only" type="button">
              <Link2 size={18} />
            </button>
            <button aria-label="Insert image" className="icon-button icon-only" type="button">
              <ImagePlus size={18} />
            </button>
            <button
              aria-label="Clear formatting"
              className="icon-button icon-only"
              onClick={() =>
                editor?.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run()
              }
              type="button"
            >
              <Pilcrow size={18} />
            </button>
          </div>
        </div>
      </div>
      {tagJumpTotal > 0 ? (
        <div className="tag-jump-bar">
          <div className="tag-jump-copy">
            <strong>#{tagJumpLabel}</strong>
            <span>
              {tagJumpPosition} of {tagJumpTotal}
            </span>
          </div>
          <div className="tag-jump-actions">
            <button className="ghost-button" onClick={onJumpToPrevious} type="button">
              Previous
            </button>
            <button className="primary-button" onClick={onJumpToNext} type="button">
              Next
            </button>
          </div>
        </div>
      ) : null}
      <section className="editor-surface">
        <div className="document-stage">
          <article className="document-page">
            <input
              className={`note-title-input${isTitleJumpTarget ? ' is-jump-target' : ''}`}
              ref={titleInputRef}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Untitled note"
              type="text"
              value={note.title}
            />
            <EditorContent editor={editor} />
          </article>
        </div>
      </section>
    </section>
  )
}

type ShlokaCardProps = {
  shloka: Shloka
  onEdit: (shloka: Shloka) => void
  onDelete: (shlokaId: string) => void
  onTagClick: (tagId: string) => void
}

function ShlokaCard({ shloka, onEdit, onDelete, onTagClick }: ShlokaCardProps) {
  const previewTitle =
    shloka.text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 72) ?? 'Untitled shloka'

  return (
    <article className="result-card shloka-card">
      <div className="note-card-row">
        <strong>{previewTitle}</strong>
        <div className="shloka-card-actions">
          <button className="ghost-button" onClick={() => onEdit(shloka)} type="button">
            Edit
          </button>
          <button className="ghost-button" onClick={() => onDelete(shloka.id)} type="button">
            Delete
          </button>
        </div>
      </div>
      <p>{shloka.text}</p>
      {shloka.tags.length ? (
        <div className="shloka-tag-group">
          {shloka.tags.map((tag) => (
            <button
              key={`${shloka.id}-${tag}`}
              className="shloka-tag-chip"
              onClick={() => onTagClick(tag)}
              type="button"
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  )
}

export default App

function createPendingTagFocus(result: TagResult): PendingTagFocus {
  return {
    noteId: result.noteId,
    tagId: result.tagId,
    occurrenceIndex: result.occurrenceIndex,
    location: result.location,
    contentOccurrenceIndex: result.contentOccurrenceIndex,
    titleRangeStart: result.titleRangeStart,
    titleRangeEnd: result.titleRangeEnd,
    requestId: Date.now(),
  }
}

function isMatchingTagResult(result: TagResult, focus: PendingTagFocus) {
  return (
    result.noteId === focus.noteId &&
    result.tagId === focus.tagId &&
    result.occurrenceIndex === focus.occurrenceIndex &&
    result.location === focus.location
  )
}

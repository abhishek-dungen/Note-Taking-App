import { createClient } from '@supabase/supabase-js'
import type { AuthChangeEvent, RealtimeChannel, Session, User } from '@supabase/supabase-js'
import type { Note } from './notes'
import type { Shloka } from './shlokas'

const SUPABASE_URL = 'https://jrczanyuirjdfsqvuzyq.supabase.co'
const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_mlNQw5yb2Ir6joRPPqbwWA_TGMZ57UP'

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    storageKey: 'quiet-notes::supabase-auth',
  },
})

export type CloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

type NoteRecord = {
  id: string
  user_id: string
  title: string
  content: Note['content']
  created_at: string
  updated_at: string
}

type ShlokaRecord = {
  id: string
  user_id: string
  title: string
  reference: string
  text: string
  tags: string[]
  status: Shloka['status']
  created_at: string
  updated_at: string
}

function mapRecordToNote(record: NoteRecord): Note {
  return {
    id: record.id,
    title: record.title,
    content: record.content,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

function mapNoteToRecord(note: Note, userId: string): NoteRecord {
  return {
    id: note.id,
    user_id: userId,
    title: note.title,
    content: note.content,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  }
}

function mapRecordToShloka(record: ShlokaRecord): Shloka {
  return {
    id: record.id,
    title: record.title,
    reference: record.reference,
    text: record.text,
    tags: record.tags,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

function mapShlokaToRecord(shloka: Shloka, userId: string): ShlokaRecord {
  return {
    id: shloka.id,
    user_id: userId,
    title: shloka.title,
    reference: shloka.reference,
    text: shloka.text,
    tags: shloka.tags,
    status: shloka.status,
    created_at: shloka.createdAt,
    updated_at: shloka.updatedAt,
  }
}

export async function getSupabaseUser(): Promise<CloudResult<User | null>> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession()

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true, data: session?.user ?? null }
}

export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<CloudResult<{ user: User | null; session: Session | null }>> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  return {
    ok: true,
    data: {
      user: data.user ?? null,
      session: data.session ?? null,
    },
  }
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<CloudResult<User>> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error || !data.user) {
    return { ok: false, error: error?.message ?? 'Unable to sign in.' }
  }

  return { ok: true, data: data.user }
}

export async function signOutSupabaseUser(): Promise<CloudResult<null>> {
  const { error } = await supabase.auth.signOut()

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true, data: null }
}

export function subscribeToAuthStateChanges(
  onChange: (event: AuthChangeEvent, session: Session | null) => void,
) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(onChange)

  return () => {
    subscription.unsubscribe()
  }
}

export async function fetchCloudNotes(userId: string): Promise<CloudResult<Note[]>> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, user_id, title, content, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    return { ok: false, error: error.message }
  }

  return {
    ok: true,
    data: (data as NoteRecord[]).map(mapRecordToNote),
  }
}

export async function fetchCloudShlokas(userId: string): Promise<CloudResult<Shloka[]>> {
  const { data, error } = await supabase
    .from('shlokas')
    .select('id, user_id, title, reference, text, tags, status, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })

  if (error) {
    return { ok: false, error: error.message }
  }

  return {
    ok: true,
    data: (data as ShlokaRecord[]).map(mapRecordToShloka),
  }
}

export async function syncCloudNotes(
  userId: string,
  notes: Note[],
): Promise<CloudResult<null>> {
  const payload = notes.map((note) => mapNoteToRecord(note, userId))

  const { error: upsertError } = await supabase
    .from('notes')
    .upsert(payload, { onConflict: 'id' })

  if (upsertError) {
    return { ok: false, error: upsertError.message }
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('notes')
    .select('id')
    .eq('user_id', userId)

  if (existingError) {
    return { ok: false, error: existingError.message }
  }

  const localIds = new Set(notes.map((note) => note.id))
  const idsToDelete = (existingRows ?? [])
    .map((row) => row.id as string)
    .filter((id) => !localIds.has(id))

  if (idsToDelete.length) {
    const { error: deleteError } = await supabase
      .from('notes')
      .delete()
      .eq('user_id', userId)
      .in('id', idsToDelete)

    if (deleteError) {
      return { ok: false, error: deleteError.message }
    }
  }

  return { ok: true, data: null }
}

export async function syncCloudShlokas(
  userId: string,
  shlokas: Shloka[],
): Promise<CloudResult<null>> {
  const payload = shlokas.map((shloka) => mapShlokaToRecord(shloka, userId))

  const { error: upsertError } = await supabase
    .from('shlokas')
    .upsert(payload, { onConflict: 'id' })

  if (upsertError) {
    return { ok: false, error: upsertError.message }
  }

  const { data: existingRows, error: existingError } = await supabase
    .from('shlokas')
    .select('id')
    .eq('user_id', userId)

  if (existingError) {
    return { ok: false, error: existingError.message }
  }

  const localIds = new Set(shlokas.map((shloka) => shloka.id))
  const idsToDelete = (existingRows ?? [])
    .map((row) => row.id as string)
    .filter((id) => !localIds.has(id))

  if (idsToDelete.length) {
    const { error: deleteError } = await supabase
      .from('shlokas')
      .delete()
      .eq('user_id', userId)
      .in('id', idsToDelete)

    if (deleteError) {
      return { ok: false, error: deleteError.message }
    }
  }

  return { ok: true, data: null }
}

export function subscribeToCloudNotes(
  userId: string,
  onChange: () => void,
): () => void {
  const channel: RealtimeChannel = supabase
    .channel(`notes-sync-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'notes',
        filter: `user_id=eq.${userId}`,
      },
      () => onChange(),
    )
    .subscribe()

  return () => {
    void supabase.removeChannel(channel)
  }
}

export function subscribeToCloudShlokas(
  userId: string,
  onChange: () => void,
): () => void {
  const channel: RealtimeChannel = supabase
    .channel(`shlokas-sync-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'shlokas',
        filter: `user_id=eq.${userId}`,
      },
      () => onChange(),
    )
    .subscribe()

  return () => {
    void supabase.removeChannel(channel)
  }
}

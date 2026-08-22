/** Generic files produced by an agent runtime or control-plane workflow. */
export interface ChatArtifact {
  kind: 'chat'
  id: string
  filename: string
  size?: number
  size_bytes?: number
  content_type?: string
  created_at: string
  download_url?: string
  conversation_id?: string
  task_id?: string | number
  sha256?: string
}

export type AnyArtifact = ChatArtifact

export function isChatArtifact(artifact: AnyArtifact): artifact is ChatArtifact {
  return artifact.kind === 'chat'
}

export type LegacyChatArtifact = ChatArtifact
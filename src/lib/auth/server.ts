import { validateSession } from './session'
export function requestToken(request: Request) {
  return (
    /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(
      request.headers.get('cookie') || '',
    )?.[1] || ''
  )
}
export const validateRequestSession = (request: Request) =>
  validateSession(requestToken(request))

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react'
import api from './api'

interface User {
  id: string
  email: string
}

interface AuthContextValue {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const TOKEN_KEY = 'auth_token'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem(TOKEN_KEY)
  )
  const [isLoading, setIsLoading] = useState(true)

  // Validate stored token on mount
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY)
    if (!storedToken) {
      setIsLoading(false)
      return
    }

    api
      .getMe()
      .then((me) => {
        setUser(me)
        setToken(storedToken)
      })
      .catch(() => {
        // Token invalid or expired
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
        setUser(null)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password)
    localStorage.setItem(TOKEN_KEY, res.token)
    setToken(res.token)

    // Fetch user info
    const me = await api.getMe()
    setUser(me)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user && !!token,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}

import { app } from 'electron'

export const is = {
  get dev() {
    return !app.isPackaged
  }
}

import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const testDb=mkdtempSync(join(tmpdir(),'acs-e2e-'));
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({testDir:'tests',workers:1,use:{baseURL:'http://127.0.0.1:3098'},projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],webServer:{command:`ACS_INSECURE_DEV_USER=e2e ACS_PGLITE_DIR=${testDb} npm run dev -- --hostname 127.0.0.1 --port 3098`,url:'http://127.0.0.1:3098',reuseExistingServer:false}});

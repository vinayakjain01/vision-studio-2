const Database = require('better-sqlite3')
const db = new Database('data/vision-studio.db')
const now = new Date().toISOString()

const tx = db.transaction(() => {
  const jobs = db.prepare(`
    UPDATE jobs SET status = 'cancelled', updated_at = ?, completed_at = ?
    WHERE status IN ('pending', 'claimed', 'running')
  `).run(now, now)

  // Images that were mid-analysis go back to 'pending' so they aren't stuck as 'processing'
  const imgs = db.prepare(`
    UPDATE images SET vision_status = 'pending', updated_at = ?
    WHERE vision_status = 'processing'
  `).run(now)

  const batches = db.prepare(`
    UPDATE batches SET status = 'cancelled', updated_at = ?
    WHERE status IN ('queued', 'running')
  `).run(now)

  console.log(`Cancelled ${jobs.changes} jobs, reset ${imgs.changes} images, cancelled ${batches.changes} batches`)
})
tx()
db.close()
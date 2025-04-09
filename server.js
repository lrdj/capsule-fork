const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');
const moment = require('moment');

const app = express();
const port = process.env.PORT || 3000;

// Database setup
const db = new sqlite3.Database('./crm.db', (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to the SQLite database.');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  db.serialize(() => {
    // Contacts table
    db.run(`CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      organisation TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tags table
    db.run(`CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )`);

    // Contact-Tags junction table
    db.run(`CREATE TABLE IF NOT EXISTS contact_tags (
      contact_id INTEGER,
      tag_id INTEGER,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (contact_id, tag_id)
    )`);

    // Opportunities table
    db.run(`CREATE TABLE IF NOT EXISTS opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      contact_id INTEGER,
      status TEXT,
      probability TEXT,
      value TEXT,
      currency TEXT,
      expected_close_date TEXT,
      actual_close_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    )`);

    // Projects table
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      contact_id INTEGER,
      status TEXT,
      expected_close_date TEXT,
      closed_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    )`);

    // Interactions table
    db.run(`CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER,
      type TEXT NOT NULL,
      summary TEXT,
      date DATETIME NOT NULL,
      calendar_event_id TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    )`);

    // Tasks table
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER,
      title TEXT NOT NULL,
      due_date DATETIME,
      status TEXT DEFAULT 'todo',
      task_track_instance_id INTEGER,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    )`);

    // Task Tracks table
    db.run(`CREATE TABLE IF NOT EXISTS task_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT
    )`);

    // Task Templates table
    db.run(`CREATE TABLE IF NOT EXISTS task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER,
      title TEXT NOT NULL,
      due_days_offset INTEGER NOT NULL,
      FOREIGN KEY (track_id) REFERENCES task_tracks(id) ON DELETE CASCADE
    )`);

    // Task Track Instances table
    db.run(`CREATE TABLE IF NOT EXISTS task_track_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER,
      track_id INTEGER,
      start_date DATETIME NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES task_tracks(id) ON DELETE CASCADE
    )`);
  });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

// Contact Routes
app.get('/contacts', (req, res) => {
  db.serialize(() => {
    // Get all contacts with their tags
    db.all(`
      SELECT c.*, GROUP_CONCAT(t.name) as tag_names, GROUP_CONCAT(t.id) as tag_ids
      FROM contacts c
      LEFT JOIN contact_tags ct ON c.id = ct.contact_id
      LEFT JOIN tags t ON ct.tag_id = t.id
      GROUP BY c.id
      ORDER BY c.name
    `, (err, contacts) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Error fetching contacts');
      }

      // Format contacts with tags
      const formattedContacts = contacts.map(contact => ({
        ...contact,
        tags: contact.tag_names ? contact.tag_names.split(',').map((name, index) => ({
          id: contact.tag_ids.split(',')[index],
          name
        })) : []
      }));

      // Get all tags for the filter
      db.all('SELECT * FROM tags ORDER BY name', (err, tags) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Error fetching tags');
        }

        res.render('contacts', { contacts: formattedContacts, tags });
      });
    });
  });
});

app.get('/contacts/new', (req, res) => {
  db.all('SELECT * FROM tags ORDER BY name', (err, tags) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error fetching tags');
    }
    res.render('contact-form', { tags });
  });
});

app.post('/contacts/new', (req, res) => {
  const { name, email, phone, organisation, notes, tags } = req.body;
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // Insert contact
    db.run(
      'INSERT INTO contacts (name, email, phone, organisation, notes) VALUES (?, ?, ?, ?, ?)',
      [name, email, phone, organisation, notes],
      function(err) {
        if (err) {
          db.run('ROLLBACK');
          console.error(err);
          return res.status(500).send('Error creating contact');
        }

        const contactId = this.lastID;

        // Insert contact-tag relationships
        if (tags && tags.length > 0) {
          const stmt = db.prepare('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)');
          tags.forEach(tagId => {
            stmt.run(contactId, tagId);
          });
          stmt.finalize();
        }

        db.run('COMMIT');
        res.redirect('/contacts');
      }
    );
  });
});

app.get('/contacts/:id/edit', (req, res) => {
  const contactId = req.params.id;
  
  db.serialize(() => {
    // Get contact with tags
    db.get(`
      SELECT c.*, GROUP_CONCAT(t.id) as tag_ids
      FROM contacts c
      LEFT JOIN contact_tags ct ON c.id = ct.contact_id
      LEFT JOIN tags t ON ct.tag_id = t.id
      WHERE c.id = ?
      GROUP BY c.id
    `, [contactId], (err, contact) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Error fetching contact');
      }

      if (!contact) {
        return res.status(404).send('Contact not found');
      }

      // Format contact with tags
      const formattedContact = {
        ...contact,
        tags: contact.tag_ids ? contact.tag_ids.split(',').map(id => ({ id })) : []
      };

      // Get all tags
      db.all('SELECT * FROM tags ORDER BY name', (err, tags) => {
        if (err) {
          console.error(err);
          return res.status(500).send('Error fetching tags');
        }

        res.render('contact-form', { contact: formattedContact, tags });
      });
    });
  });
});

app.post('/contacts/:id/edit', (req, res) => {
  const contactId = req.params.id;
  const { name, email, phone, organisation, notes, tags } = req.body;
  
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // Update contact
    db.run(
      'UPDATE contacts SET name = ?, email = ?, phone = ?, organisation = ?, notes = ? WHERE id = ?',
      [name, email, phone, organisation, notes, contactId],
      (err) => {
        if (err) {
          db.run('ROLLBACK');
          console.error(err);
          return res.status(500).send('Error updating contact');
        }

        // Delete existing contact-tag relationships
        db.run('DELETE FROM contact_tags WHERE contact_id = ?', [contactId], (err) => {
          if (err) {
            db.run('ROLLBACK');
            console.error(err);
            return res.status(500).send('Error updating tags');
          }

          // Insert new contact-tag relationships
          if (tags && tags.length > 0) {
            const stmt = db.prepare('INSERT INTO contact_tags (contact_id, tag_id) VALUES (?, ?)');
            tags.forEach(tagId => {
              stmt.run(contactId, tagId);
            });
            stmt.finalize();
          }

          db.run('COMMIT');
          res.redirect('/contacts');
        });
      }
    );
  });
});

app.delete('/contacts/:id', (req, res) => {
  const contactId = req.params.id;
  
  db.run('DELETE FROM contacts WHERE id = ?', [contactId], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Error deleting contact');
    }
    res.sendStatus(200);
  });
});

// Import Routes
app.get('/contacts/import', (req, res) => {
  res.render('import-contacts');
});

app.post('/contacts/import', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    const { skip_first_row } = req.body;
    const source = req.body.source || 'custom';

    const results = {
        total: 0,
        imported: 0,
        errors: []
    };

    // Create a queue for database operations
    const dbQueue = [];
    let isProcessing = false;

    const processQueue = () => {
        if (isProcessing || dbQueue.length === 0) return;
        
        isProcessing = true;
        const operation = dbQueue.shift();
        
        operation(() => {
            isProcessing = false;
            processQueue();
        });
    };

    fs.createReadStream(req.file.path)
        .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
        .on('data', (row) => {
            results.total++;
            
            if (skip_first_row && results.total === 1) {
                return;
            }

            // Skip empty rows
            if (!row || Object.keys(row).length === 0) {
                return;
            }

            try {
                let contact;
                if (source === 'capsule') {
                    // Skip if no name or organisation
                    if (!row['First Name'] && !row['Last Name'] && !row['Organisation']) {
                        return;
                    }

                    contact = {
                        name: row['First Name'] && row['Last Name'] 
                            ? `${row['First Name']} ${row['Last Name']}`.trim()
                            : row['Organisation'] || '',
                        email: row['Email Address'] || row['Work Email'] || '',
                        phone: row['Mobile Phone'] || row['Direct Phone'] || row['Work Phone'] || row['Phone Number'] || '',
                        organisation: row['Organisation'] || '',
                        notes: [row['About'], row['History']].filter(Boolean).join('\n\n')
                    };
                } else {
                    contact = {
                        name: row[req.body.mapping?.name] || '',
                        email: row[req.body.mapping?.email] || '',
                        phone: row[req.body.mapping?.phone] || '',
                        organisation: row[req.body.mapping?.organisation] || '',
                        notes: row[req.body.mapping?.notes] || ''
                    };
                }

                if (!contact.name) {
                    return; // Skip rows without a name instead of throwing an error
                }

                // Queue the database operation
                dbQueue.push((callback) => {
                    db.run(
                        'INSERT INTO contacts (name, email, phone, organisation, notes) VALUES (?, ?, ?, ?, ?)',
                        [contact.name, contact.email, contact.phone, contact.organisation, contact.notes],
                        function(err) {
                            if (err) {
                                results.errors.push(`Row ${results.total}: ${err.message}`);
                            } else {
                                const contactId = this.lastID;
                                results.imported++;

                                // Process tags if present
                                let tags = [];
                                if (source === 'capsule' && row['Tags']) {
                                    tags = row['Tags'].split(';').map(tag => tag.trim()).filter(Boolean);
                                } else if (req.body.mapping?.tags && row[req.body.mapping.tags]) {
                                    tags = row[req.body.mapping.tags].split(',').map(tag => tag.trim()).filter(Boolean);
                                }

                                if (tags.length > 0) {
                                    tags.forEach(tag => {
                                        dbQueue.push((tagCallback) => {
                                            db.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tag], (err) => {
                                                if (err) {
                                                    results.errors.push(`Error inserting tag ${tag}: ${err.message}`);
                                                    tagCallback();
                                                    return;
                                                }
                                                
                                                db.get('SELECT id FROM tags WHERE name = ?', [tag], (err, tagRow) => {
                                                    if (err) {
                                                        results.errors.push(`Error getting tag ID for ${tag}: ${err.message}`);
                                                        tagCallback();
                                                        return;
                                                    }
                                                    
                                                    if (tagRow) {
                                                        db.run(
                                                            'INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)',
                                                            [contactId, tagRow.id],
                                                            (err) => {
                                                                if (err) {
                                                                    results.errors.push(`Error linking tag ${tag}: ${err.message}`);
                                                                }
                                                                tagCallback();
                                                            }
                                                        );
                                                    } else {
                                                        tagCallback();
                                                    }
                                                });
                                            });
                                        });
                                    });
                                }
                            }
                            callback();
                        }
                    );
                });

                processQueue();
            } catch (error) {
                results.errors.push(`Row ${results.total}: ${error.message}`);
            }
        })
        .on('end', () => {
            // Wait for all queued operations to complete
            const checkQueue = () => {
                if (dbQueue.length === 0 && !isProcessing) {
                    // Delete the file first
                    fs.unlink(req.file.path, (err) => {
                        if (err) console.error('Error deleting file:', err);
                        // Then send the response
                        res.json(results);
                    });
                } else {
                    setTimeout(checkQueue, 100);
                }
            };
            checkQueue();
        })
        .on('error', (error) => {
            console.error('Error processing file:', error);
            res.status(500).json({ error: 'Error processing file' });
        });
});

// Add new routes for opportunities and projects
app.get('/opportunities', (req, res) => {
    db.all(`
        SELECT o.*, c.name as contact_name 
        FROM opportunities o
        LEFT JOIN contacts c ON o.contact_id = c.id
        ORDER BY o.created_at DESC
    `, (err, opportunities) => {
        if (err) {
            console.error(err);
            res.status(500).send('Error fetching opportunities');
        } else {
            res.render('opportunities', { opportunities });
        }
    });
});

app.get('/projects', (req, res) => {
    db.all(`
        SELECT p.*, c.name as contact_name 
        FROM projects p
        LEFT JOIN contacts c ON p.contact_id = c.id
        ORDER BY p.created_at DESC
    `, (err, projects) => {
        if (err) {
            console.error(err);
            res.status(500).send('Error fetching projects');
        } else {
            res.render('projects', { projects });
        }
    });
});

// Add import routes for opportunities and projects
app.get('/opportunities/import', (req, res) => {
    res.render('import-opportunities');
});

app.get('/projects/import', (req, res) => {
    res.render('import-projects');
});

app.post('/opportunities/import', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    const { skip_first_row } = req.body;
    const source = req.body.source || 'custom';

    const results = {
        total: 0,
        imported: 0,
        errors: []
    };

    // Create a queue for database operations
    const dbQueue = [];
    let isProcessing = false;

    const processQueue = () => {
        if (isProcessing || dbQueue.length === 0) return;
        
        isProcessing = true;
        const operation = dbQueue.shift();
        
        operation(() => {
            isProcessing = false;
            processQueue();
        });
    };

    fs.createReadStream(req.file.path)
        .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
        .on('data', (row) => {
            results.total++;
            
            if (skip_first_row && results.total === 1) {
                return;
            }

            // Skip empty rows
            if (!row || Object.keys(row).length === 0) {
                return;
            }

            try {
                let opportunity;
                if (source === 'capsule') {
                    // Skip if no opportunity name
                    if (!row['Opportunity Name']) {
                        return;
                    }

                    opportunity = {
                        name: row['Opportunity Name'],
                        description: row['Opportunity Description'] || '',
                        status: row['Milestone'] || '',
                        probability: row['Probability'] || '',
                        value: row['Estimated Value'] || '',
                        currency: row['Currency'] || '',
                        expected_close_date: row['Expected Close Date'] || '',
                        actual_close_date: row['Actual Close Date'] || ''
                    };
                } else {
                    opportunity = {
                        name: row[req.body.mapping?.name] || '',
                        description: row[req.body.mapping?.description] || '',
                        status: row[req.body.mapping?.status] || '',
                        probability: row[req.body.mapping?.probability] || '',
                        value: row[req.body.mapping?.value] || '',
                        currency: row[req.body.mapping?.currency] || '',
                        expected_close_date: row[req.body.mapping?.expected_close_date] || '',
                        actual_close_date: row[req.body.mapping?.actual_close_date] || ''
                    };
                }

                if (!opportunity.name) {
                    return; // Skip rows without a name
                }

                // Find contact ID if available
                let contactId = null;
                if (source === 'capsule' && row['Contact Name']) {
                    dbQueue.push((callback) => {
                        db.get('SELECT id FROM contacts WHERE name = ?', [row['Contact Name']], (err, contact) => {
                            if (err) {
                                results.errors.push(`Error finding contact for ${row['Contact Name']}: ${err.message}`);
                            } else if (contact) {
                                contactId = contact.id;
                            }
                            callback();
                        });
                    });
                }

                // Queue the opportunity insert
                dbQueue.push((callback) => {
                    db.run(
                        `INSERT INTO opportunities (
                            name, description, contact_id, status, probability, 
                            value, currency, expected_close_date, actual_close_date
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            opportunity.name,
                            opportunity.description,
                            contactId,
                            opportunity.status,
                            opportunity.probability,
                            opportunity.value,
                            opportunity.currency,
                            opportunity.expected_close_date,
                            opportunity.actual_close_date
                        ],
                        function(err) {
                            if (err) {
                                results.errors.push(`Error inserting opportunity ${opportunity.name}: ${err.message}`);
                            } else {
                                results.imported++;
                            }
                            callback();
                        }
                    );
                });

                processQueue();
            } catch (error) {
                results.errors.push(`Row ${results.total}: ${error.message}`);
            }
        })
        .on('end', () => {
            // Wait for all queued operations to complete
            const checkQueue = () => {
                if (dbQueue.length === 0 && !isProcessing) {
                    // Delete the file first
                    fs.unlink(req.file.path, (err) => {
                        if (err) console.error('Error deleting file:', err);
                        // Then send the response
                        res.json(results);
                    });
                } else {
                    setTimeout(checkQueue, 100);
                }
            };
            checkQueue();
        })
        .on('error', (error) => {
            console.error('Error processing file:', error);
            res.status(500).json({ error: 'Error processing file' });
        });
});

app.post('/projects/import', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded');
    }

    const { skip_first_row } = req.body;
    const source = req.body.source || 'custom';

    const results = {
        total: 0,
        imported: 0,
        errors: []
    };

    // Check if file is empty
    const stats = fs.statSync(req.file.path);
    if (stats.size === 0) {
        fs.unlink(req.file.path, (err) => {
            if (err) console.error('Error deleting file:', err);
        });
        return res.status(400).json({ error: 'File is empty' });
    }

    // Create a queue for database operations
    const dbQueue = [];
    let isProcessing = false;
    let hasData = false;

    const processQueue = () => {
        if (isProcessing || dbQueue.length === 0) return;
        
        isProcessing = true;
        const operation = dbQueue.shift();
        
        operation(() => {
            isProcessing = false;
            processQueue();
        });
    };

    fs.createReadStream(req.file.path)
        .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
        .on('data', (row) => {
            hasData = true;
            results.total++;
            
            if (skip_first_row && results.total === 1) {
                return;
            }

            // Skip empty rows
            if (!row || Object.keys(row).length === 0) {
                return;
            }

            try {
                let project;
                if (source === 'capsule') {
                    // Skip if no project name
                    if (!row['Project Name']) {
                        return;
                    }

                    project = {
                        name: row['Project Name'],
                        description: row['Project Description'] || '',
                        status: row['Status'] || '',
                        expected_close_date: row['Expected Close Date'] || '',
                        closed_date: row['Closed Date'] || ''
                    };
                } else {
                    project = {
                        name: row[req.body.mapping?.name] || '',
                        description: row[req.body.mapping?.description] || '',
                        status: row[req.body.mapping?.status] || '',
                        expected_close_date: row[req.body.mapping?.expected_close_date] || '',
                        closed_date: row[req.body.mapping?.closed_date] || ''
                    };
                }

                if (!project.name) {
                    return; // Skip rows without a name
                }

                // Find contact ID if available
                let contactId = null;
                if (source === 'capsule' && row['Contact Name']) {
                    dbQueue.push((callback) => {
                        db.get('SELECT id FROM contacts WHERE name = ?', [row['Contact Name']], (err, contact) => {
                            if (err) {
                                results.errors.push(`Error finding contact for ${row['Contact Name']}: ${err.message}`);
                            } else if (contact) {
                                contactId = contact.id;
                            }
                            callback();
                        });
                    });
                }

                // Queue the project insert
                dbQueue.push((callback) => {
                    db.run(
                        `INSERT INTO projects (
                            name, description, contact_id, status, 
                            expected_close_date, closed_date
                        ) VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            project.name,
                            project.description,
                            contactId,
                            project.status,
                            project.expected_close_date,
                            project.closed_date
                        ],
                        function(err) {
                            if (err) {
                                results.errors.push(`Error inserting project ${project.name}: ${err.message}`);
                            } else {
                                results.imported++;
                            }
                            callback();
                        }
                    );
                });

                processQueue();
            } catch (error) {
                results.errors.push(`Row ${results.total}: ${error.message}`);
            }
        })
        .on('end', () => {
            // Wait for all queued operations to complete
            const checkQueue = () => {
                if (dbQueue.length === 0 && !isProcessing) {
                    // Delete the file first
                    fs.unlink(req.file.path, (err) => {
                        if (err) console.error('Error deleting file:', err);
                        // Then send the response
                        if (!hasData) {
                            res.status(400).json({ error: 'No valid data found in file' });
                        } else {
                            res.json(results);
                        }
                    });
                } else {
                    setTimeout(checkQueue, 100);
                }
            };
            checkQueue();
        })
        .on('error', (error) => {
            console.error('Error processing file:', error);
            res.status(500).json({ error: 'Error processing file' });
        });
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
}); 
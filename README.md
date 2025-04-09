# Personal CRM

A lightweight, single-user CRM tool for managing contacts, tasks, and interactions.

## Features

- Contact management with tags
- Interaction history tracking
- Task management with due dates
- Task tracks (predefined task clusters)
- CSV/Capsule contact import
- Simple, intuitive interface

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
4. Open your browser and navigate to `http://localhost:3000`

## Database

The application uses SQLite for data storage. The database file (`crm.db`) will be automatically created when you first run the application.

## Importing Contacts

You can import contacts from a CSV file or Capsule export format. The import feature supports the following fields:
- Name
- Email
- Phone
- Organisation
- Tags
- Notes

## Development

- Backend: Node.js with Express
- Database: SQLite
- Frontend: EJS templates with vanilla JavaScript
- Styling: Custom CSS

## License

MIT

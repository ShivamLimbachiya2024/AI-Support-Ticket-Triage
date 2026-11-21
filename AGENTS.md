# Repository Guidance

## Project structure

This is a TypeScript Express backend for support ticket triage. Keep code organized by responsibility:

- `src/app.ts`: Express application setup and startup.
- `src/router/`: top-level route composition.
- `src/modules/<feature>/`: feature-specific `router/`, `controller/`, `validation-schema/`, and `enum/` code. Follow the existing `auth` module layout when adding features.
- `src/sequelize/models/`: Sequelize model definitions and model registration.
- `src/sequelize/interface/`: interfaces paired with Sequelize models.
- `src/sequelize/migrations/`: Sequelize CLI migration files.
- `src/sequelize/config/`: Sequelize CLI database configuration.
- `src/middleware/`: shared Express middleware.
- `src/helper/`, `src/utils/`, and `src/config/`: shared response helpers, utilities, and configuration.

Use the existing naming and import conventions in neighboring files. Model files currently use the `.modal.ts` suffix; preserve that convention unless the repository is deliberately renamed consistently. Keep code readable and maintainable as the primary goal. Do not add unnecessary normalization or transformations. Use `_` or `-` as separators in keys and identifiers where applicable; do not use `:` as a separator. Use `snake_case` for database column names and other variable names, following that convention consistently across interfaces, model attributes, and queries.

## Required database and migration practices

- **Always create migrations through the Sequelize CLI command. Never create a migration file manually.** Pass the intended name and exact destination path through the CLI, for example: `npx sequelize-cli migration:generate --name add-example --migrations-path src/sequelize/migrations`.
- Implement migration changes using Sequelize's migration/query-interface APIs. Avoid raw SQL queries; use the defined Sequelize ORM/query-interface operations.
- For each new database entity, add its model under `src/sequelize/models/` and its TypeScript interface under `src/sequelize/interface/`, following the existing structure. Register models if required by the model loader.
- Keep database columns and model schema values such as statuses represented as strings. Do not define Sequelize model-level enums.
- Define status and other finite domain values as TypeScript enums in the relevant feature's `enum/` folder, and use those enum members for comparisons and database operation values. Avoid scattered string literals for status checks.

## Environment configuration

- **Do not use fallback values for environment variables.** Read required configuration explicitly and fail clearly when it is missing or invalid, so configuration errors do not silently change behavior or corrupt data. Add a fallback only when the user explicitly requests that specific fallback.
- Do not use patterns such as `process.env.VALUE || defaultValue` or `process.env.VALUE ?? defaultValue` for environment configuration unless that fallback was explicitly requested.

## Required implementation practices

- Validate every submitted POST/request body with Joi before controller logic. Put schemas in the feature's `validation-schema/` folder and apply the shared validation middleware in the route.
- Use Lodash for object operations and manipulations; do not substitute plain JavaScript object helpers for those operations.
- Avoid regular expressions. For simple string handling, use basic JavaScript string functions instead.
- Keep feature-specific routes, controllers, schemas, and enums in the corresponding feature module. Put cross-cutting behavior in shared middleware/helpers.
- Preserve strict TypeScript typing and existing Express/Sequelize patterns.
- After defining a function, add and run a test that exercises that function. Function-level test coverage is mandatory.
- Avoid unnecessary helper functions, wrappers, or abstractions. Keep a small operation inline when it is only used once and is clear in place; extract a function when it improves readability or supports genuine reuse.
- Avoid unnecessary normalization or transformation steps. Make only changes needed for the requirement and keep the data flow straightforward.
- Prefer readable, maintainable code over clever or overly compact implementations. Apply `snake_case` to variables and database columns, and use `_` or `-` rather than `:` when separating keys or identifiers.

## Logging, errors, and request lifecycle

- Use a global Express error-handling middleware to catch and log application errors, then return a consistent failure response. Register it after the routes so it receives propagated errors.
- Add global request/response logging middleware. For every response, log the HTTP method, route/path, client IP, and response status (and useful duration/details where available).
- Log before and after each meaningful application operation. Include useful identifiers and state, such as ticket ID, prior/new status, or result details.
- Every log message must be a readable string that tells what happened, such as `Ticket 42 triage completed successfully` or `Ticket 42 status updated to resolved`. Do not pass JSON objects as log messages.
- Keep logs actionable and avoid logging secrets, credentials, tokens, or sensitive request bodies. Use the repository logger (Pino) rather than adding ad hoc console logging.

## Completion checklist

- New routes validate input with Joi and follow the feature module structure.
- New statuses use shared feature enums while model/database columns remain strings.
- Migrations were generated with Sequelize CLI at `src/sequelize/migrations` and use ORM/query-interface methods.
- Models and interfaces are in their established directories and are registered where needed.
- Global error handling and request/response logging remain in the Express middleware chain.
- Operation logs are readable strings with relevant identifiers and outcomes.
- Every newly defined function has a test that exercises it, and the tests are run.
- Required environment variables have no implicit fallback values.
- Naming follows the required separator and `snake_case` conventions. Code avoids unnecessary normalization, abstractions, and transformations, and remains easy to read and maintain.

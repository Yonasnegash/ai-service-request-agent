import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000)
const app = createApp()

const server = app.listen(port, () => {
    console.log(`Service Request Agent listening on port ${port}`)
})

function shutdown(signal: string) {
    console.log(`${signal} received; shutting down`)

    server.close((error) => {
        if (error) {
            console.log("Error while closing HTTP server", error)
        }
    })
}

process.on('SIGINT', () => shutdown('SIGING'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
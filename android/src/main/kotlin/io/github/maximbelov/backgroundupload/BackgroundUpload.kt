package io.github.maximbelov.backgroundupload

import com.getcapacitor.Logger

class BackgroundUpload {

    fun echo(value: String): String {
        Logger.info("Echo", value)

        return value
    }
}

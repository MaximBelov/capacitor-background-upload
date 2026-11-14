import { BackgroundUpload } from 'capacitor-plugin-background-upload';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    BackgroundUpload.echo({ value: inputValue })
}
